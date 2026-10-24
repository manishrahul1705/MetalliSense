"""
MetalliSense — Mechanical Property Prediction API
==================================================

Two prediction modes:
  1. Formula-based (mech_predict.py) — explainable, works from day one
  2. ML-based (trained models) — faster, single call, retrain on real UTM data later

Mount in your existing FastAPI app:
    from mech_api import router as mech_router
    app.include_router(mech_router)
"""
import os
import pickle
from typing import Dict, List, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from mech_predict import (
    predict_mechanical,
    carbon_equivalent,
    MECH_STANDARDS,
)

router = APIRouter(prefix="/mechanical", tags=["Mechanical Properties"])

# ── Load ML models ──────────────────────────────────────────
MODEL_DIR = os.path.join(os.path.dirname(__file__), 'models', 'mechanical')

_ml_models = {}
_metadata = None


def _load_ml():
    global _ml_models, _metadata
    try:
        with open(os.path.join(MODEL_DIR, 'metadata.pkl'), 'rb') as f:
            _metadata = pickle.load(f)
        for target in _metadata['targets_reg']:
            with open(os.path.join(MODEL_DIR, f'{target}_model.pkl'), 'rb') as f:
                _ml_models[target] = pickle.load(f)
        with open(os.path.join(MODEL_DIR, 'quality_classifier.pkl'), 'rb') as f:
            _ml_models['classifier'] = pickle.load(f)
        print(f"✅ Mechanical property ML models loaded ({len(_ml_models)} models)")
    except Exception as e:
        print(f"⚠️ ML models not loaded (formula mode only): {e}")


_load_ml()


# ── Schemas ─────────────────────────────────────────────────

class Composition(BaseModel):
    C: float = Field(..., ge=0, le=5, description="Carbon wt%")
    Si: float = Field(..., ge=0, le=4, description="Silicon wt%")
    Mn: float = Field(..., ge=0, le=3, description="Manganese wt%")
    P: float = Field(..., ge=0, le=0.3, description="Phosphorus wt%")
    S: float = Field(..., ge=0, le=0.2, description="Sulphur wt%")


class MechRequest(BaseModel):
    grade: str
    composition: Composition
    mode: str = Field("formula", description="'formula' (explainable) or 'ml' (fast)")


class BatchItem(BaseModel):
    grade: str
    composition: Composition


class BatchRequest(BaseModel):
    items: List[BatchItem]
    mode: str = "ml"


# ── Endpoints ───────────────────────────────────────────────

@router.post("/predict")
def predict(req: MechRequest):
    """
    Predict UTS, YS, elongation, hardness and PASS/FAIL from chemistry.

    Two modes:
    - formula: uses published metallurgical relationships, returns full explanation
    - ml: uses the trained gradient-boosting models, faster, less explanation
    """
    c = req.composition
    grade = req.grade.upper()

    if grade not in MECH_STANDARDS:
        raise HTTPException(400, f"Unknown grade '{grade}'. "
                            f"Available: {list(MECH_STANDARDS.keys())}")

    if req.mode == "formula":
        return predict_mechanical(grade, c.C, c.Si, c.Mn, c.P, c.S)

    elif req.mode == "ml":
        is_steel = 'STEEL' in grade
        ce_val = carbon_equivalent(c.C, c.Mn) if is_steel else round(c.C + (c.Si + c.P) / 3.0, 4)

        if not _ml_models or not _metadata:
            # Fall back to formula mode seamlessly if ML models are not present
            fallback = predict_mechanical(grade, c.C, c.Si, c.Mn, c.P, c.S)
            fallback['mode'] = 'formula_fallback'
            return fallback

        x = _build_features(grade, c)
        result = {
            'grade': grade,
            'material_family': 'steel' if is_steel else 'cast_iron',
        }
        for target in _metadata['targets_reg']:
            pred = float(_ml_models[target].predict(x)[0])
            result[f'predicted_{target.lower()}'] = round(pred, 1)

        prob = _ml_models['classifier'].predict_proba(x)[0]
        result['pass_probability'] = round(float(prob[1]), 3)
        result['quality_result'] = 'PASS' if prob[1] > 0.5 else 'FAIL'
        result['carbon_equivalent'] = round(ce_val, 4)
        return result

    else:
        raise HTTPException(400, "mode must be 'formula' or 'ml'")


@router.post("/predict/batch")
def predict_batch(req: BatchRequest):
    """Predict mechanical properties for multiple heats at once."""
    results = []
    for item in req.items:
        single = MechRequest(grade=item.grade, composition=item.composition, mode=req.mode)
        results.append(predict(single))
    return {"results": results, "count": len(results)}


@router.get("/standards")
def get_standards():
    """Return the reference standards used for PASS/FAIL checks."""
    return {"standards": MECH_STANDARDS}


@router.get("/standards/{grade}")
def get_standard(grade: str):
    grade = grade.upper()
    if grade not in MECH_STANDARDS:
        raise HTTPException(404, f"Unknown grade '{grade}'")
    return {"grade": grade, **MECH_STANDARDS[grade]}


@router.post("/ce-check")
def ce_check(req: MechRequest):
    """
    Quick carbon equivalent check with budget breakdown.
    Useful as a live indicator while the operator watches the OES screen.
    """
    c = req.composition
    grade = req.grade.upper()
    is_steel = 'STEEL' in grade

    if is_steel:
        CE = carbon_equivalent(c.C, c.Mn)
        budget = [
            {"element": "C", "value": c.C, "ce_contribution": round(c.C, 4),
             "share_pct": round(c.C / CE * 100, 1) if CE > 0 else 0},
            {"element": "Mn/6", "value": c.Mn, "ce_contribution": round(c.Mn / 6, 4),
             "share_pct": round(c.Mn / 6 / CE * 100, 1) if CE > 0 else 0},
        ]
    else:
        CE = c.C + (c.Si + c.P) / 3.0
        budget = [
            {"element": "C", "value": c.C, "ce_contribution": round(c.C, 4),
             "share_pct": round(c.C / CE * 100, 1) if CE > 0 else 0},
            {"element": "Si/3", "value": c.Si, "ce_contribution": round(c.Si / 3, 4),
             "share_pct": round((c.Si / 3) / CE * 100, 1) if CE > 0 else 0},
            {"element": "P/3", "value": c.P, "ce_contribution": round(c.P / 3, 4),
             "share_pct": round((c.P / 3) / CE * 100, 1) if CE > 0 else 0},
        ]

    std = MECH_STANDARDS.get(grade, {})
    ce_max = std.get('ce_max')

    return {
        "carbon_equivalent": round(CE, 4),
        "material_family": "steel" if is_steel else "cast_iron",
        "ce_limit": ce_max,
        "ce_margin": round(ce_max - CE, 4) if ce_max else None,
        "status": "PASS" if (ce_max is None or CE <= ce_max) else "FAIL",
        "weldability": ("OK" if CE <= 0.40 else "REDUCED" if CE <= 0.45 else "POOR") if is_steel else "NOT_APPLICABLE",
        "budget": budget,
    }


@router.get("/model-info")
def model_info():
    """Return info about the loaded ML models."""
    if not _metadata:
        return {"status": "formula_only", "message": "No ML models loaded"}
    return {
        "status": "ml_ready",
        "features": _metadata['feature_names'],
        "targets": _metadata['targets_reg'],
        "grades": _metadata['grades'],
        "classifier": "GradientBoostingClassifier (PASS/FAIL)",
    }


def _build_features(grade: str, c: Composition):
    """Build feature vector matching the training format."""
    x = [c.C, c.Si, c.Mn, c.P, c.S]
    grade_vec = [1.0 if g == grade else 0.0 for g in _metadata['grades']]
    return np.array([x + grade_vec])
