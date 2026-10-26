"""
Configuration settings for MetalliSense AI Service
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file — use an ABSOLUTE path so this
# works no matter which folder you happen to run "python app/main.py"
# from. Without this, load_dotenv() silently loads nothing if your current
# directory isn't exactly right, causing intermittent "works, then doesn't"
# behavior (Gemini/ElevenLabs config vanishing between runs).
_ENV_PATH = Path(__file__).parent.parent / ".env"
_env_loaded = load_dotenv(dotenv_path=_ENV_PATH)
print(f"[config] .env path: {_ENV_PATH} (exists: {_ENV_PATH.exists()}, loaded: {_env_loaded})")
print(f"[config] COPILOT_PROVIDER = {os.getenv('COPILOT_PROVIDER', '(not set — defaults to groq)')}")

# Base directories
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
MODELS_DIR = BASE_DIR / "models"

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# Model paths
ANOMALY_MODEL_PATH = MODELS_DIR / "anomaly_model.pkl"
ALLOY_MODEL_PATH = MODELS_DIR / "alloy_model.pkl"
DATASET_PATH = DATA_DIR / "dataset.csv"

# Anomaly detection thresholds
ANOMALY_SEVERITY_THRESHOLDS = {
    "LOW": 0.0,      # 0.0 - 0.33
    "MEDIUM": 0.33,  # 0.33 - 0.66
    "HIGH": 0.66     # 0.66 - 1.0
}

# Elements tracked
ELEMENTS = ["Fe", "C", "Si", "Mn", "P", "S"]

# Synthetic data generation parameters
SYNTHETIC_DATASET_SIZE = 30000
NORMAL_RATIO = 0.65  # 65% normal samples
DEVIATED_RATIO = 0.35  # 35% deviated samples

# Model training parameters
ANOMALY_CONTAMINATION = 0.05  # Expected proportion of outliers (highly sensitive detection - only 5% expected anomalies)
RANDOM_STATE = 42

# API settings
API_HOST = os.getenv("API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("API_PORT", 8001))
API_TITLE = "MetalliSense AI Service"
API_VERSION = "1.0.0"

# Safety constraints
MAX_ADDITION_PERCENTAGE = 5.0  # Maximum 5% addition of any element
MIN_CONFIDENCE_THRESHOLD = 0.5  # Minimum confidence to provide recommendations
# Groq API Configuration (for Explainable AI Copilot)
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")  # Set via environment variable
GROQ_MODEL = "llama-3.3-70b-versatile"  # Groq's reasoning model
GROQ_TEMPERATURE = 0.3  # Low temperature for consistent technical explanations
GROQ_MAX_TOKENS = 2000  # Maximum tokens for response

# Voice Service Configuration
TTS_LANGUAGE = "en"  # Default language for text-to-speech
TTS_SLOW = False  # Normal speed by default