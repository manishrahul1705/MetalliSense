"""
MetalliSense AI Service - FastAPI Application
Main entry point for the AI Intelligence Layer
"""
from fastapi import FastAPI, HTTPException, status, Request
import os
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from pathlib import Path
import sys

# Add app directory to path
sys.path.append(str(Path(__file__).parent))

from config import API_HOST, API_PORT, API_TITLE, API_VERSION
from schemas import (
    AnomalyRequest, 
    AnomalyResponse,
    AlloyRecommendationRequest,
    AlloyRecommendationResponse,
    HealthResponse
)
from inference.anomaly_predict import get_anomaly_predictor
from inference.alloy_predict import get_alloy_predictor
from mech_api import router as mech_router

# Initialize FastAPI app
app = FastAPI(
    title=API_TITLE,
    version=API_VERSION,
    description="AI Intelligence Layer for MetalliSense - Anomaly Detection & Alloy Correction",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Add CORS middleware for Node.js integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount mechanical property prediction routes

# Scoped internal service authentication middleware (Fail-closed; no hardcoded defaults)
def get_service_key() -> str:
    key = os.getenv("METALLISENSE_AI_SERVICE_KEY") or os.getenv("METALLISENSE_INTERNAL_SERVICE_KEY")
    return (key or "").strip()

@app.middleware("http")
async def verify_internal_service_auth(request: Request, call_next):
    public_paths = {"/", "/health", "/docs", "/redoc", "/openapi.json"}
    if request.url.path in public_paths or request.method == "OPTIONS":
        return await call_next(request)
    
    expected_key = get_service_key()
    if not expected_key:
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "code": "SERVICE_AUTH_UNCONFIGURED",
                "message": "Service authentication is not configured; failing closed."
            }
        )
    
    token = request.headers.get("X-Internal-Service-Key")
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = token or auth_header[7:].strip()
    
    if not token:
        return JSONResponse(
            status_code=401,
            content={
                "status": "fail",
                "code": "UNAUTHORIZED_SERVICE",
                "message": "Direct access rejected: internal service authentication required."
            }
        )
    if token != expected_key:
        return JSONResponse(
            status_code=403,
            content={
                "status": "fail",
                "code": "FORBIDDEN_SERVICE",
                "message": "Invalid or unauthorized internal service token."
            }
        )
    return await call_next(request)

app.include_router(mech_router)

# Global predictors (lazy loaded)
anomaly_predictor = None
alloy_predictor = None


def initialize_models():
    """Initialize AI models on startup"""
    global anomaly_predictor, alloy_predictor
    
    try:
        print("Initializing AI models...")
        anomaly_predictor = get_anomaly_predictor()
        alloy_predictor = get_alloy_predictor()
        print("✓ AI models loaded successfully")
        return True
    except Exception as e:
        print(f"✗ Error loading AI models: {e}")
        print("Models must be trained before starting the API service.")
        print("Run: python app/training/train_anomaly.py")
        print("Run: python app/training/train_alloy_agent.py")
        return False


@app.on_event("startup")
async def startup_event():
    """Startup event handler"""
    print("="*60)
    print(f"{API_TITLE} v{API_VERSION}")
    print("="*60)
    initialize_models()
    print("="*60)
    print(f"API Server starting on http://{API_HOST}:{API_PORT}")
    print(f"Documentation: http://{API_HOST}:{API_PORT}/docs")
    print("="*60)


@app.get("/", tags=["Root"])
async def root():
    """Root endpoint"""
    return {
        "service": API_TITLE,
        "version": API_VERSION,
        "status": "running",
        "endpoints": {
            "health": "/health",
            "anomaly_detection": "/anomaly/predict",
            "alloy_correction": "/alloy/recommend",
            "grades": "/grades",
            "docs": "/docs"
        }
    }


@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    """
    Health check endpoint
    Returns status of AI models
    """
    models_loaded = {
        "anomaly_model": anomaly_predictor is not None and anomaly_predictor.is_healthy(),
        "alloy_model": alloy_predictor is not None and alloy_predictor.is_healthy()
    }
    
    all_healthy = all(models_loaded.values())
    
    return HealthResponse(
        status="healthy" if all_healthy else "degraded",
        message="All models loaded" if all_healthy else "Some models not loaded",
        models_loaded=models_loaded
    )


@app.post("/anomaly/predict", response_model=AnomalyResponse, tags=["Anomaly Detection"])
async def predict_anomaly(request: AnomalyRequest):
    """
    Anomaly Detection Endpoint
    
    Detects abnormal spectrometer behavior:
    - Sensor drift
    - Measurement noise
    - Unstable melt chemistry
    
    **This endpoint does NOT decide if metal is PASS/FAIL**
    
    Returns:
    - anomaly_score: 0.0 (normal) to 1.0 (highly anomalous)
    - severity: LOW, MEDIUM, or HIGH
    - message: Human-readable explanation
    """
    if anomaly_predictor is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Anomaly detection model not loaded. Please train the model first."
        )
    
    try:
        # Convert Pydantic model to dict
        composition = request.composition.dict()
        grade = request.grade  # Optional grade parameter
        
        # Get prediction with grade-aware detection
        result = anomaly_predictor.predict(composition, grade=grade)
        
        # Check for errors
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["message"]
            )
        
        return AnomalyResponse(
            anomaly_score=result["anomaly_score"],
            severity=result["severity"],
            message=result["message"]
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Prediction error: {str(e)}"
        )


@app.post("/alloy/recommend", response_model=AlloyRecommendationResponse, tags=["Alloy Correction"])
async def recommend_alloy_additions(request: AlloyRecommendationRequest):
    """
    Alloy Correction Recommendation Endpoint
    
    Given a deviated composition, recommends:
    - Which alloying elements to add
    - Required amount (%) for each element
    
    **This endpoint does NOT decide if metal is PASS/FAIL**
    
    It only answers: "What alloy additions will correct the deviation?"
    
    Returns:
    - recommended_additions: Dict of element additions (%)
    - confidence: 0.0 to 1.0
    - message: Human-readable explanation
    - warning: Safety warnings if applicable
    """
    if alloy_predictor is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Alloy correction model not loaded. Please train the model first."
        )
    
    try:
        # Convert Pydantic model to dict
        composition = request.composition.dict()
        grade = request.grade
        
        # Validate grade
        available_grades = alloy_predictor.get_available_grades()
        if grade not in available_grades:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown grade: {grade}. Available grades: {available_grades}"
            )
        
        # Get prediction
        result = alloy_predictor.predict(grade, composition)
        
        # Check for errors
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["message"]
            )
        
        return AlloyRecommendationResponse(
            recommended_additions=result["recommended_additions"],
            confidence=result["confidence"],
            message=result["message"],
            warning=result.get("warning")
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Prediction error: {str(e)}"
        )


@app.get("/grades", tags=["Grades"])
async def get_available_grades():
    """
    Get list of available metal grades
    
    Returns all grades supported by the alloy correction agent
    """
    if alloy_predictor is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Alloy correction model not loaded"
        )
    
    try:
        grades = alloy_predictor.get_available_grades()
        return {
            "grades": grades,
            "count": len(grades)
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving grades: {str(e)}"
        )


@app.get("/grades/{grade}", tags=["Grades"])
async def get_grade_specification(grade: str):
    """
    Get specification for a specific grade
    
    Returns composition ranges for all elements in the grade
    """
    if alloy_predictor is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Alloy correction model not loaded"
        )
    
    try:
        spec = alloy_predictor.get_grade_spec(grade)
        return spec
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving grade specification: {str(e)}"
        )


# Exception handlers
@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    """Custom HTTP exception handler"""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.detail,
            "status_code": exc.status_code
        }
    )


@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    """General exception handler"""
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "Internal server error",
            "detail": str(exc),
            "status_code": 500
        }
    )


if __name__ == "__main__":
    # Run the application
    uvicorn.run(
        "main:app",
        host=API_HOST,
        port=API_PORT,
        reload=False,
        log_level="info"
    )
