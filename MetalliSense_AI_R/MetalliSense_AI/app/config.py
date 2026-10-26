"""
Configuration settings for MetalliSense AI Service
"""
import os
from pathlib import Path

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
SYNTHETIC_DATASET_SIZE = 200000  # Scaled up from 30,000 to 200,000 for better model performance
NORMAL_RATIO = 0.65  # 65% normal samples
DEVIATED_RATIO = 0.35  # 35% deviated samples

# Model training parameters
ANOMALY_CONTAMINATION = 0.35  # Expected proportion of outliers
RANDOM_STATE = 42

# API settings
API_HOST = os.getenv("API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("API_PORT", 8000))
API_TITLE = "MetalliSense AI Service"
API_VERSION = "1.0.0"

# Safety constraints
MAX_ADDITION_PERCENTAGE = 5.0  # Maximum 5% addition of any element
MIN_CONFIDENCE_THRESHOLD = 0.5  # Minimum confidence to provide recommendations
