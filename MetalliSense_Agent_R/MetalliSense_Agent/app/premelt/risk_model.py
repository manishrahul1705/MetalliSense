"""
Pre-Melt Charge Risk Model

Answers one question before the furnace is switched on:
    "If we melt this charge, how likely is the heat to end up off-spec?"

Input is the chemistry the charge mix is PREDICTED to melt down to
(computed by the Node backend from the raw-material lots), plus the
uncertainty of that prediction.

Why a separate model instead of the existing Anomaly Detection Agent:
the anomaly agent is one Isolation Forest trained across all grades to
spot unusual spectrometer readings (sensor drift, noise). It is not
grade-aware, so it cannot say whether a chemistry is right for the
grade being made. This model is trained per grade on the labelled
historical heats in dataset.csv (is_deviated), so its output is a
grade-specific probability of an off-spec heat.

Features: C, Si, Mn, P, S.
Fe is left out on purpose: it is the balance element (whatever is not
the other elements) and no cast-iron or steel standard sets a limit on it.
"""
import sys
from pathlib import Path
from typing import Dict, Optional

import numpy as np

try:
    import joblib
except ImportError:
    joblib = None

try:
    import pandas as pd
except ImportError:
    pd = None

try:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import train_test_split
except ImportError:
    HistGradientBoostingClassifier = None
    roc_auc_score = None
    train_test_split = None

sys.path.append(str(Path(__file__).parent.parent))

from config import DATASET_PATH, MODELS_DIR, RANDOM_STATE  # noqa: E402

FEATURES = ["C", "Si", "Mn", "P", "S"]
# Impurities: less is never worse. The synthetic dataset also labels P/S
# BELOW the grade minimum as "deviated", which is not how a plant thinks,
# so at inference any P/S under the grade's normal mean is scored as the mean.
IMPURITIES = ["P", "S"]
MODEL_PATH = MODELS_DIR / "premelt_risk_model.pkl"
MODEL_VERSION = 1


class ChargeRiskModel:
    """One gradient-boosted classifier per grade: chemistry -> P(off-spec heat)."""

    def __init__(self):
        self.models: Dict[str, HistGradientBoostingClassifier] = {}
        self.normal_stats: Dict[str, Dict[str, Dict[str, float]]] = {}
        self.metrics: Dict[str, Dict[str, float]] = {}
        self.is_trained = False

    # ------------------------------------------------------------------ training
    def train(self, df) -> Dict[str, Dict[str, float]]:
        if pd is None or HistGradientBoostingClassifier is None:
            raise ImportError("Model training requires pandas and scikit-learn.")
        labels = df["is_deviated"].astype(str).str.strip().str.lower().isin(["true", "1"])
        df = df.assign(_y=labels.astype(int))

        for grade, d in df.groupby("grade"):
            grade = str(grade).upper()
            X = d[FEATURES].to_numpy(dtype=float)
            y = d["_y"].to_numpy()
            if len(np.unique(y)) < 2 or len(d) < 200:
                continue

            X_tr, X_te, y_tr, y_te = train_test_split(
                X, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y
            )
            holdout = HistGradientBoostingClassifier(
                max_iter=200, learning_rate=0.1, random_state=RANDOM_STATE
            ).fit(X_tr, y_tr)
            auc = float(roc_auc_score(y_te, holdout.predict_proba(X_te)[:, 1]))

            # Refit on all rows for the production model
            model = HistGradientBoostingClassifier(
                max_iter=200, learning_rate=0.1, random_state=RANDOM_STATE
            ).fit(X, y)

            normal = d[d["_y"] == 0]
            self.models[grade] = model
            self.normal_stats[grade] = {
                el: {
                    "mean": float(normal[el].mean()),
                    "std": float(normal[el].std() or 1e-6),
                    "p05": float(normal[el].quantile(0.05)),
                    "p95": float(normal[el].quantile(0.95)),
                }
                for el in FEATURES
            }
            self.metrics[grade] = {
                "holdout_auc": round(auc, 4),
                "rows": int(len(d)),
                "off_spec_share": round(float(y.mean()), 4),
            }

        self.is_trained = bool(self.models)
        return self.metrics

    # ----------------------------------------------------------------- inference
    def grades(self):
        return sorted(self.models.keys())

    def _proba(self, grade: str, rows: np.ndarray) -> np.ndarray:
        return self.models[grade].predict_proba(rows)[:, 1]

    def assess(
        self,
        grade: str,
        composition: Dict[str, float],
        sigma: Optional[Dict[str, float]] = None,
        n_samples: int = 400,
        seed: int = RANDOM_STATE,
    ) -> Dict:
        """
        Risk of an off-spec heat for a predicted chemistry.

        sigma: 1-standard-deviation uncertainty per element. The prediction
        is sampled n_samples times inside that uncertainty, so a charge whose
        chemistry is uncertain (e.g. only supplier-declared values) scores
        riskier than the same nominal chemistry backed by lab results.
        """
        grade = grade.upper()
        if grade not in self.models:
            return {
                "risk": 0.5,
                "risk_nominal": 0.5,
                "risk_band_p10_p90": [0.4, 0.6],
                "drivers": [],
                "note": f"Grade {grade} not in trained model ({self.grades()}). Neutral risk heuristic applied."
            }

        sigma = sigma or {}
        x0 = np.array([[float(composition[el]) for el in FEATURES]])
        s = np.array([max(float(sigma.get(el, 0.0)), 0.0) for el in FEATURES])

        stats = self.normal_stats[grade]
        floor = np.array([stats[el]["mean"] if el in IMPURITIES else 0.0 for el in FEATURES])
        reported = x0.copy()
        x0 = np.maximum(x0, floor)

        risk_nominal = float(self._proba(grade, x0)[0])

        if s.sum() > 0:
            rng = np.random.default_rng(seed)
            samples = np.clip(rng.normal(x0[0], s, size=(n_samples, len(FEATURES))), 0.0, None)
            samples = np.maximum(samples, floor)
            probs = self._proba(grade, samples)
            risk_mean = float(probs.mean())
            band = [float(np.percentile(probs, 10)), float(np.percentile(probs, 90))]
        else:
            risk_mean = risk_nominal
            band = [risk_nominal, risk_nominal]

        # Explain: how much would the risk drop if this one element were at
        # the grade's normal (in-spec historical) mean?
        all_normal = np.array([[stats[el]["mean"] for el in FEATURES]])
        base_risk = float(self._proba(grade, all_normal)[0])
        drivers = []
        for i, el in enumerate(FEATURES):
            only = all_normal.copy()
            only[0, i] = x0[0, i]
            risk_only = float(self._proba(grade, only)[0])
            cf = x0.copy()
            cf[0, i] = stats[el]["mean"] if el not in IMPURITIES else min(x0[0, i], stats[el]["mean"])
            risk_cf = float(self._proba(grade, cf)[0])
            z = (reported[0, i] - stats[el]["mean"]) / stats[el]["std"]
            drivers.append({
                "element": el,
                "value": round(float(reported[0, i]), 4),
                "normal_mean": round(stats[el]["mean"], 4),
                "z_score": round(float(z), 2),
                "risk_drop_if_normal": round(risk_nominal - risk_cf, 4),
                "risk_if_only_this": round(risk_only, 4),
                # How much this element explains the risk, whether it is the
                # only problem or one of several.
                "impact": round(max(risk_nominal - risk_cf, risk_only - base_risk, 0.0), 4),
            })
        drivers.sort(key=lambda d: d["impact"], reverse=True)

        return {
            "risk": round(risk_mean, 4),
            "risk_nominal": round(risk_nominal, 4),
            "risk_band_p10_p90": [round(band[0], 4), round(band[1], 4)],
            "drivers": drivers,
        }

    # -------------------------------------------------------------- persistence
    def save(self, path: Path = MODEL_PATH):
        joblib.dump(
            {
                "version": MODEL_VERSION,
                "features": FEATURES,
                "models": self.models,
                "normal_stats": self.normal_stats,
                "metrics": self.metrics,
            },
            path,
        )

    def load(self, path: Path = MODEL_PATH):
        if joblib is None:
            raise ImportError("Model loading requires joblib.")
        data = joblib.load(path)
        if data.get("version") != MODEL_VERSION or data.get("features") != FEATURES:
            raise ValueError("Saved pre-melt risk model is from an older version")
        self.models = data["models"]
        self.normal_stats = data["normal_stats"]
        self.metrics = data["metrics"]
        self.is_trained = bool(self.models)


_model: Optional[ChargeRiskModel] = None


def train_and_save(dataset_path: Path = DATASET_PATH, save_path: Path = MODEL_PATH) -> ChargeRiskModel:
    model = ChargeRiskModel()
    df = pd.read_csv(dataset_path)
    df["grade"] = df["grade"].astype(str).str.upper()
    model.train(df)
    model.save(save_path)
    return model


def get_charge_risk_model() -> ChargeRiskModel:
    """Load the saved model, or train it from dataset.csv on first use (~5 s)."""
    global _model
    if _model is None:
        model = ChargeRiskModel()
        try:
            model.load(MODEL_PATH)
        except Exception:
            try:
                model = train_and_save()
            except Exception:
                pass
        _model = model
    return _model
