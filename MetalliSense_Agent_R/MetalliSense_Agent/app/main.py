
"""
MetalliSense AI Service - FastAPI Application
Main entry point for the AI Intelligence Layer
"""
from fastapi import FastAPI, HTTPException, status, File, UploadFile, Request
import os
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
import uvicorn
from pathlib import Path
import sys
from typing import Optional
import tempfile
import os

# Add app directory to path
sys.path.append(str(Path(__file__).parent))

from config import API_HOST, API_PORT, API_TITLE, API_VERSION
from schemas import (
    AnomalyRequest, 
    AnomalyResponse,
    AlloyRecommendationRequest,
    AlloyRecommendationResponse,
    HealthResponse,
    # Agent-based schemas
    AgentAnalysisRequest,
    AgentAnalysisResponse
)
from inference.anomaly_predict import get_anomaly_predictor
from vectorsearch import indexer, vector_store
from inference.alloy_predict import get_alloy_predictor
from agents.agent_manager import get_agent_manager

# Copilot imports
from copilot import get_copilot, get_voice_service
from copilot.schemas import (
    ExplainAnalysisRequest,
    ExplainAnalysisResponse,
    ChatRequest,
    ChatResponse,
    TTSRequest,
    TranscriptionResponse,
    LanguagesResponse
)

# Pre-Melt Gate (charge risk before the furnace starts)
from premelt import assess_charge, get_charge_risk_model
from premelt.schemas import PreMeltAssessRequest, PreMeltAssessResponse

# Closed-loop RL optimization imports
from rl.schemas import (
    RLOptimizeRequest,
    RLOptimizeResponse,
    RLFeedbackRequest,
    RLFeedbackResponse,
    RLStatusResponse
)

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
    expose_headers=["X-TTS-Provider"],
    allow_headers=["*"],
)


# Scoped internal service authentication middleware (Fail-closed; no hardcoded defaults)
def get_service_key() -> str:
    key = os.getenv("METALLISENSE_AGENT_SERVICE_KEY") or os.getenv("METALLISENSE_INTERNAL_SERVICE_KEY")
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

# Global predictors (lazy loaded)
anomaly_predictor = None
alloy_predictor = None
agent_manager = None
copilot = None
voice_service = None
rl_engine = None


def initialize_models():
    """Initialize AI models on startup.

    Each subsystem is initialized independently so that one failure
    (e.g. a missing GROQ_API_KEY) does not prevent the others from
    loading, and so the real cause of each failure is visible in the
    logs instead of being swallowed by a single catch-all except.
    """
    global anomaly_predictor, alloy_predictor, agent_manager, copilot, voice_service, rl_engine

    ok = True

    print("Initializing AI models...")
    try:
        anomaly_predictor = get_anomaly_predictor()
        alloy_predictor = get_alloy_predictor()
        print("✓ AI models loaded successfully")
    except Exception as e:
        print(f"✗ AI models failed to load: {e}")
        print("  Run: python app/training/train_anomaly.py")
        print("  Run: python app/training/train_alloy_agent.py")
        ok = False

    print("Initializing Agent Manager...")
    try:
        agent_manager = get_agent_manager()
        print("✓ Agent Manager initialized")
    except Exception as e:
        print(f"✗ Agent Manager failed to load: {e}")
        ok = False

    print("Initializing Explainable AI Copilot...")
    try:
        copilot = get_copilot()
        print("✓ Copilot initialized")
    except Exception as e:
        print(f"✗ Copilot failed to load: {e}")
        print("  Check that GROQ_API_KEY is set in the environment (.env)")
        ok = False

    print("Initializing Voice Service...")
    try:
        voice_service = get_voice_service()
        print("✓ Voice Service initialized")
    except Exception as e:
        print(f"✗ Voice Service failed to load: {e}")
        print("  Check GROQ_API_KEY / ELEVENLABS_API_KEY in the .env file")
        ok = False

    print("Initializing Closed-Loop RL Optimization Engine...")
    try:
        from rl import get_rl_engine
        rl_engine = get_rl_engine()
        print("✓ RL Optimization Engine initialized "
              f"({rl_engine.reward_model.n_updates} prior updates loaded)")
    except Exception as e:
        print(f"✗ RL Optimization Engine failed to load: {e}")
        print("  Run: python app/training/train_rl.py to bootstrap it")
        ok = False

    print("Initializing Pre-Melt charge risk model...")
    try:
        risk_model = get_charge_risk_model()
        print(f"✓ Pre-Melt risk model ready ({len(risk_model.grades())} grades)")
    except Exception as e:
        print(f"✗ Pre-Melt risk model failed to load: {e}")
        print("  Run: python app/training/train_premelt_risk.py")
        ok = False

    return ok


@app.on_event("startup")
async def startup_event():
    """Startup event handler"""
    print("="*60)
    print(f"{API_TITLE} v{API_VERSION}")
    print("="*60)
    initialize_models()
    print("=" * 60)
    print("Building vector search index (Actian VectorAI DB integration)...")
    index_result = indexer.build_index()
    print(f"  Backend: {vector_store.backend_name()}")
    print(f"  Grades indexed: {index_result.get('grades', 0)}")
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
            "agent_analysis": "/agents/analyze",
            "anomaly_detection": "/anomaly/predict",
            "alloy_correction": "/alloy/recommend",
            "copilot_explain": "/copilot/explain",
            "copilot_chat": "/copilot/chat",
            "copilot_voice_transcribe": "/copilot/voice/transcribe",
            "copilot_voice_synthesize": "/copilot/voice/synthesize",
            "rl_optimize": "/rl/optimize",
            "rl_feedback": "/rl/feedback",
            "rl_policy_status": "/rl/policy/status",
            "grades": "/grades",
            "docs": "/docs"
        }
    }


@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    """
    Health check endpoint
    Returns status of AI models and agents
    """
    models_loaded = {
        "anomaly_model": anomaly_predictor is not None and anomaly_predictor.is_healthy(),
        "alloy_model": alloy_predictor is not None and alloy_predictor.is_healthy(),
        "agent_manager": agent_manager is not None and agent_manager.is_ready(),
        "copilot": copilot is not None,
        "voice_service": voice_service is not None,
        "rl_engine": rl_engine is not None and rl_engine.is_healthy()
    }
    
    all_healthy = all(models_loaded.values())
    
    return HealthResponse(
        status="healthy" if all_healthy else "degraded",
        message="All models loaded" if all_healthy else "Some models not loaded",
        models_loaded=models_loaded
    )


# ============================================================================
# AGENT-BASED ENDPOINTS (Production Agent Architecture)
# ============================================================================

@app.post("/agents/analyze", response_model=AgentAnalysisResponse, tags=["Agents"])
async def agent_analysis(request: AgentAnalysisRequest):
    """
    🤖 AGENT ANALYSIS ENDPOINT
    
    Production-grade agent orchestration for MetalliSense
    
    This endpoint:
    ✅ Triggers Agent Manager
    ✅ Coordinates Anomaly Detection Agent
    ✅ Conditionally invokes Alloy Correction Agent
    ✅ Aggregates responses with safety notes
    
    Agent Workflow:
    1. Anomaly Detection Agent ALWAYS runs
    2. If HIGH severity detected, Alloy Correction Agent runs
    3. All outputs require human approval
    4. No autonomous actions
    
    Request:
    ```json
    {
        "composition": {"Fe": 81.2, "C": 4.4, "Si": 3.1, "Mn": 0.4, "P": 0.04, "S": 0.02},
        "grade": "SG-IRON"
    }
    ```
    
    Response:
    ```json
    {
        "anomaly_agent": {
            "agent": "AnomalyDetectionAgent",
            "anomaly_score": 0.87,
            "severity": "HIGH",
            "confidence": 0.93,
            "explanation": "..."
        },
        "alloy_agent": {
            "agent": "AlloyCorrectionAgent",
            "recommended_additions": {"Si": 0.22, "Mn": 0.15},
            "confidence": 0.91,
            "explanation": "..."
        },
        "final_note": "Human approval required before action"
    }
    ```
    
    🔐 Safety:
    - Agents are advisory only
    - No autonomous actions
    - Human approval ALWAYS required
    - All decisions logged
    """
    if agent_manager is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent Manager not initialized. Please train models first."
        )
    
    if not agent_manager.is_ready():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent Manager not ready. Some agents are not initialized."
        )
    
    try:
        # Convert Pydantic model to dict
        composition = request.composition.dict()
        grade = request.grade
        
        # Orchestrate agent analysis
        result = agent_manager.analyze(composition, grade)
        
        # Return aggregated response
        return AgentAnalysisResponse(**result)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Agent analysis error: {str(e)}"
        )


# ============================================================================
# LEGACY ENDPOINTS (Backward Compatibility)
# ============================================================================

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
        
        # Get prediction
        result = anomaly_predictor.predict(composition)
        
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


# ============================================================================
# VECTOR SEARCH (Actian VectorAI DB integration — PEC Hacks 4.0)
# ============================================================================

@app.get("/vector/status", tags=["Vector Search"])
async def vector_status():
    """Shows whether we're connected to the real Actian VectorAI DB or
    running on the local fallback store, plus how many items are indexed."""
    return {
        "backend": vector_store.backend_name(),
        "using_real_vectorai": vector_store.is_using_real_vectorai(),
        "grade_specs_indexed": vector_store.count(indexer.GRADE_COLLECTION),
        "memories_stored": vector_store.count(indexer.MEMORY_COLLECTION),
    }


@app.post("/vector/reindex", tags=["Vector Search"])
async def vector_reindex():
    """(Re)builds the grade-spec semantic search index."""
    result = indexer.build_index(force=True)
    return result


@app.post("/vector/search", tags=["Vector Search"])
async def vector_search(request: dict):
    """
    🔎 Semantic search over grade specifications.
    Body: { "query": "cast iron with high carbon", "top_k": 5 }
    Finds grades by MEANING, not exact keyword match — e.g. searching
    "ductile iron for pipes" can surface SG-IRON even without those exact
    words in the stored text.
    """
    query = request.get("query")
    top_k = request.get("top_k", 5)
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    results = indexer.semantic_search(query, top_k)
    return {"status": "success", "backend": vector_store.backend_name(), "results": results}


@app.post("/vector/memory/add", tags=["Vector Search"])
async def vector_memory_add(request: dict):
    """Store a piece of text (e.g. a copilot chat turn) as AI Agent memory."""
    text = request.get("text")
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    indexer.remember(text, metadata=request.get("metadata"))
    return {"status": "success"}


@app.post("/vector/memory/recall", tags=["Vector Search"])
async def vector_memory_recall(request: dict):
    """Retrieve the most semantically relevant past memories for a query —
    used to give the AI Agent copilot long-term, meaning-based recall
    instead of just the last N messages."""
    query = request.get("query")
    top_k = request.get("top_k", 3)
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    results = indexer.recall(query, top_k)
    return {"status": "success", "results": results}


# ============================================================================
# COPILOT ENDPOINTS (Explainable AI with Groq LLM)
# ============================================================================

@app.post("/copilot/explain", response_model=ExplainAnalysisResponse, tags=["Copilot"])
async def explain_analysis(request: ExplainAnalysisRequest, include_voice: bool = False):
    """
    🤖 EXPLAINABLE AI - Get human explanation for ML predictions
    
    Takes composition and grade, runs full agent analysis, and generates
    human-readable explanation using Groq LLM.
    
    This endpoint:
    ✅ Runs anomaly detection
    ✅ Runs alloy correction (if needed)
    ✅ Generates natural language explanation
    ✅ Provides risk assessment
    ✅ Gives operator action items
    
    Request:
    ```json
    {
        "composition": {"Fe": 94.5, "C": 3.2, "Si": 2.0, "Mn": 0.4, "P": 0.05, "S": 0.10},
        "grade": "GREY-IRON"
    }
    ```
    
    Response includes:
    - Full explanation text (human-readable)
    - Brief summary
    - Action items for operators
    - Risk level assessment
    - Confidence score
    - Analysis context (ML predictions)
    
    🔐 Safety:
    - Explanations are advisory only
    - Human approval ALWAYS required
    - All recommendations logged
    """
    if copilot is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Explainable AI Copilot not initialized"
        )
    
    if agent_manager is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent Manager not initialized"
        )
    
    try:
        # Run agent analysis first
        composition = request.composition
        grade = request.grade
        
        agent_result = agent_manager.analyze(composition, grade)
        
        # Generate explanation
        explanation_result = copilot.explain_analysis(
            composition=composition,
            grade=grade,
            anomaly_result=agent_result.get("anomaly_agent"),
            alloy_result=agent_result.get("alloy_agent")
        )
        
        return ExplainAnalysisResponse(**explanation_result)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Explanation generation error: {str(e)}"
        )


@app.post("/copilot/chat", response_model=ChatResponse, tags=["Copilot"])
async def chat_with_copilot(request: ChatRequest):
    """
    💬 CHATBOT - Interactive Q&A with AI Copilot
    
    Ask questions about the latest analysis, metallurgical concepts,
    or get clarification on recommendations.
    
    Examples:
    - "Why do we need to add Manganese?"
    - "What happens if we don't correct this?"
    - "Explain the risk level"
    - "What is the confidence score?"
    
    The copilot maintains conversation history and can reference
    previous questions and the latest analysis context.
    
    Request:
    ```json
    {
        "message": "Why do we need to add Manganese?",
        "include_context": true
    }
    ```
    
    Response:
    ```json
    {
        "response": "Manganese is recommended because...",
        "conversation_id": "12345"
    }
    ```
    """
    if copilot is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Explainable AI Copilot not initialized"
        )
    
    try:
        response = copilot.chat(
            user_message=request.message,
            include_context=request.include_context
        )
        
        return ChatResponse(**response)
    
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Chat error: {str(e)}"
        )


@app.delete("/copilot/chat/history", tags=["Copilot"])
async def clear_chat_history():
    """
    🗑️ Clear conversation history
    
    Clears the conversation history for a fresh start.
    Useful when starting a new analysis session.
    """
    if copilot is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Explainable AI Copilot not initialized"
        )
    
    try:
        copilot.clear_history()
        return {"message": "Conversation history cleared", "success": True}
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error clearing history: {str(e)}"
        )


@app.post("/copilot/voice/transcribe", response_model=TranscriptionResponse, tags=["Voice"])
async def transcribe_audio(audio: UploadFile = File(...), language: Optional[str] = None):
    """
    🎤 SPEECH-TO-TEXT - Convert voice input to text
    
    Upload audio file and get transcribed text.
    Uses Groq Whisper large-v3 model for high accuracy.
    
    Supported formats: WAV, MP3, M4A, OGG, FLAC
    
    Example usage:
    ```bash
    curl -X POST "http://localhost:8001/copilot/voice/transcribe" \
         -F "audio=@recording.wav" \
         -F "language=en"
    ```
    
    Response:
    ```json
    {
        "text": "Why do we need to add manganese?",
        "language": "en",
        "success": true
    }
    ```
    """
    if voice_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Voice Service not initialized"
        )
    
    try:
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(audio.filename).suffix) as tmp:
            content = await audio.read()
            tmp.write(content)
            tmp_path = tmp.name
        
        try:
            # Transcribe
            result = voice_service.transcribe_audio(tmp_path, language)
            return TranscriptionResponse(**result)
        finally:
            # Clean up temp file
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Transcription error: {str(e)}"
        )


@app.post("/copilot/voice/synthesize", tags=["Voice"])
async def synthesize_speech(request: TTSRequest):
    """
    🔊 TEXT-TO-SPEECH - Convert text to voice
    
    Convert text to speech audio (MP3 format).
    Uses Google Text-to-Speech (gTTS) for natural voice output.
    
    Request:
    ```json
    {
        "text": "Manganese addition of 0.15% is recommended to improve tensile strength.",
        "language": "en",
        "slow": false
    }
    ```
    
    Returns: MP3 audio file
    
    Supported languages: en, es, fr, de, it, pt, ru, ja, ko, zh, hi, ar
    
    Example usage in browser:
    ```javascript
    const response = await fetch('/copilot/voice/synthesize', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text: "Hello", language: "en"})
    });
    const blob = await response.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    audio.play();
    ```
    """
    if voice_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Voice Service not initialized"
        )
    
    try:
        audio_bytes = voice_service.text_to_speech(
            text=request.text,
            language=request.language,
            slow=request.slow
        )
        
        if not audio_bytes:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"No audio produced (ElevenLabs: {voice_service.last_error or 'n/a'})"
            )
        return Response(
            content=audio_bytes,
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": "inline; filename=speech.mp3",
                "X-TTS-Provider": voice_service.last_provider_used or "unknown",
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Speech synthesis error: {str(e)}"
        )


@app.get("/copilot/voice/status", tags=["Voice"])
async def voice_status():
    """Which TTS/STT providers are active (no secrets returned)."""
    if voice_service is None:
        return {"available": False}
    return {"available": True, **voice_service.status()}


@app.get("/copilot/voice/languages", response_model=LanguagesResponse, tags=["Voice"])
async def get_supported_languages():
    """
    🌍 Get supported languages for voice services
    
    Returns list of language codes and names supported
    by both Speech-to-Text and Text-to-Speech services.
    
    Response:
    ```json
    {
        "languages": {
            "en": "English",
            "es": "Spanish",
            "fr": "French",
            ...
        }
    }
    ```
    """
    if voice_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Voice Service not initialized"
        )
    
    try:
        languages = voice_service.get_supported_languages()
        return LanguagesResponse(languages=languages)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving languages: {str(e)}"
        )


@app.post("/rl/optimize", response_model=RLOptimizeResponse, tags=["Closed-Loop RL Optimization"])
async def rl_optimize(request: RLOptimizeRequest):
    """
    🔁 CLOSED-LOOP RL — Propose alloy correction strategies

    Returns several ranked candidate corrections (conservative / balanced /
    aggressive) for the given composition and grade. Each candidate is
    scored by a Q-function that is continuously updated from operator
    feedback and (when available) measured production outcomes via
    /rl/feedback — this is the "closed loop" the policy learns from.

    Safety: every candidate is clipped to hard manufacturing constraints
    (per-element and total addition limits). Nothing here is ever
    auto-applied — `requires_human_approval` is always true, and a
    qualified operator must review before any addition is made.
    """
    if rl_engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="RL Optimization Engine not initialized. "
                   "Run app/training/train_rl.py to bootstrap it."
        )
    try:
        result = rl_engine.propose(request.grade, request.composition, top_k=request.top_k)
        return RLOptimizeResponse(**result)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"RL optimization error: {str(e)}"
        )


@app.post("/rl/feedback", response_model=RLFeedbackResponse, tags=["Closed-Loop RL Optimization"])
async def rl_feedback(request: RLFeedbackRequest):
    """
    🔁 CLOSED-LOOP RL — Submit operator decision / production outcome

    Call this after a human operator has accepted, modified, or rejected
    a proposed correction — and again later with `actual_result` once the
    real post-correction composition is measured, if you want the policy
    to learn from ground truth rather than operator judgement alone.

    Every call here immediately updates the live Q-function (online
    learning via partial_fit) and is appended to an audit log for full
    traceability of human-in-the-loop decisions.
    """
    if rl_engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="RL Optimization Engine not initialized. "
                   "Run app/training/train_rl.py to bootstrap it."
        )
    if request.outcome not in ("accepted", "modified", "rejected"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="outcome must be one of: accepted, modified, rejected"
        )
    try:
        result = rl_engine.record_feedback(
            grade=request.grade,
            composition=request.composition,
            additions=request.additions,
            aggressiveness=request.aggressiveness,
            outcome=request.outcome,
            actual_result=request.actual_result,
            operator_note=request.operator_note,
        )
        return RLFeedbackResponse(**result)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"RL feedback error: {str(e)}"
        )


@app.get("/rl/policy/status", response_model=RLStatusResponse, tags=["Closed-Loop RL Optimization"])
async def rl_policy_status():
    """
    🔁 CLOSED-LOOP RL — Inspect current policy learning progress

    Shows how many feedback updates the policy has absorbed, the running
    average reward over the last 100 updates, and a recent reward trend —
    useful for a dashboard chart showing the policy improving over time.
    """
    if rl_engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="RL Optimization Engine not initialized."
        )
    return RLStatusResponse(**rl_engine.status())


# Exception handlers
# ============================================================================
# PRE-MELT GATE
# ============================================================================

@app.post("/premelt/assess", response_model=PreMeltAssessResponse, tags=["Pre-Melt Gate"])
async def premelt_assess(request: PreMeltAssessRequest):
    """
    AI check of a charge mix BEFORE the furnace starts.

    Input: the melt-down chemistry the Node backend predicts from the
    charge lots, plus its 1-sigma uncertainty per element.

    Output:
    - off-spec risk of the heat as charged (per-grade classifier)
    - corrective additions from the existing Alloy Correction Agent
      (only C, Si, Mn — what a melt shop actually adds)
    - off-spec risk after those additions

    High risk AFTER correction means additions cannot save the heat
    (element above max, or P/S too high) and the charge must change.
    Advisory only: the gate decision is made by the backend.
    """
    try:
        risk_model = get_charge_risk_model()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Pre-melt risk model unavailable: {e}"
        )

    grade = request.grade.upper()
    if grade not in risk_model.grades():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown grade: {grade}. Available grades: {risk_model.grades()}"
        )

    try:
        result = assess_charge(
            grade,
            request.composition.dict(),
            request.uncertainty,
            alloy_predictor=alloy_predictor,
        )
        return PreMeltAssessResponse(**result)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Pre-melt assessment error: {str(e)}"
        )


@app.get("/premelt/model/status", tags=["Pre-Melt Gate"])
async def premelt_model_status():
    """Grades covered by the pre-melt risk model and their holdout AUC."""
    try:
        risk_model = get_charge_risk_model()
        return {"ready": True, "grades": risk_model.grades(), "metrics": risk_model.metrics}
    except Exception as e:
        return {"ready": False, "error": str(e)}


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
