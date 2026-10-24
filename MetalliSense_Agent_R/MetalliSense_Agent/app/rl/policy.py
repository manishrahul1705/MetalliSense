"""
Closed-loop RL alloy correction policy.

Design summary
---------------
This is a contextual-bandit-style optimizer, not a full MDP/deep-RL
agent — that's a deliberate choice: alloy correction is a single-shot
decision per pour (choose an addition, observe an outcome), not a long
multi-step sequential control problem, so a bandit is the right-sized
tool and it lets us use an incrementally-trainable, fully local,
dependency-light model (SGDRegressor.partial_fit) instead of a deep RL
stack that would need a GPU and a simulator neither of which exist here.

Flow
----
1. `propose(grade, composition)`:
   - Starts from the existing supervised AlloyCorrectionAgent's base
     recommendation (already trained on historical corrections).
   - Generates 3 candidate "strategies" by scaling that recommendation
     (conservative 0.5x, balanced 1.0x, aggressive 1.5x), each clipped
     to hard manufacturing safety constraints.
   - Scores every candidate with the learned Q-function (reward_model),
     which was bootstrapped offline from historical production data and
     is continuously updated online from operator feedback.
   - Returns all candidates ranked best-first. NOTHING is auto-applied —
     the response is a set of recommendations for a human operator to
     approve, edit, or reject.

2. `record_feedback(...)`:
   - Operator submits what actually happened: which candidate (if any)
     was used, whether it was accepted/modified/rejected, and — when
     known — the measured composition after correction.
   - A reward is computed from that outcome (see `_compute_reward`) and
     fed into the Q-function via `partial_fit`. This is the "closed
     loop": every real-world decision changes future recommendations.
   - The event is appended to an audit log (`feedback_store`) so the
     policy can be rebuilt offline at any time and every human decision
     stays traceable.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.path.append(str(Path(__file__).parent.parent))

from config import ELEMENTS
from data.grade_specs import GradeSpecificationGenerator
from inference.alloy_predict import get_alloy_predictor

from .constraints import clip_additions, constraint_violations, cost_of
from .feedback_store import append_feedback
from .reward_model import RewardModel

AGGRESSIVENESS_LEVELS = {
    "conservative": 0.3,
    "balanced": 1.0,
    "aggressive": 2.0,
}


def _scale_additions(base: Dict[str, float], scale: float) -> Dict[str, float]:
    return {el: max(0.0, float(base.get(el, 0.0))) * scale for el in ELEMENTS}


def _distance_to_midpoint(grade_gen: GradeSpecificationGenerator, grade: str, composition: Dict[str, float]) -> float:
    midpoints = grade_gen.get_composition_midpoint(grade)
    spec = grade_gen.get_grade_spec(grade)
    total = 0.0
    for el in ELEMENTS:
        if el not in midpoints or el not in spec["composition_ranges"]:
            continue
        lo, hi = spec["composition_ranges"][el]
        width = max(hi - lo, 1e-6)
        # normalize distance by the spec width so every element contributes
        # comparably regardless of its natural scale (Fe vs P, say)
        total += abs(composition.get(el, midpoints[el]) - midpoints[el]) / width
    return total


class RLOptimizationEngine:
    def __init__(self):
        self.grade_generator = GradeSpecificationGenerator()
        self.alloy_predictor = get_alloy_predictor()
        known_grades = self.grade_generator.get_available_grades()
        self.reward_model = RewardModel.load()
        for g in known_grades:
            if g not in self.reward_model.known_grades:
                self.reward_model.known_grades.append(g)

    def is_healthy(self) -> bool:
        return self.reward_model is not None

    # ------------------------------------------------------------------
    def propose(self, grade: str, composition: Dict[str, float], top_k: int = 3) -> Dict:
        deviation = self.grade_generator.get_deviation_from_spec(grade, composition)
        base = self.alloy_predictor.predict(grade, composition)
        base_additions = base.get("recommended_additions", {}) or {}

        candidates = []
        for label, scale in AGGRESSIVENESS_LEVELS.items():
            raw = _scale_additions(base_additions, scale)
            clipped = clip_additions(raw)
            violations = constraint_violations(clipped)
            predicted_reward = self.reward_model.predict(deviation, grade, clipped, scale)
            candidates.append(
                {
                    "strategy": label,
                    "aggressiveness": scale,
                    "recommended_additions": {k: round(v, 4) for k, v in clipped.items() if v > 1e-6},
                    "predicted_reward": round(predicted_reward, 4),
                    "estimated_cost": round(cost_of(clipped), 4),
                    "constraint_violations": violations,
                    "requires_human_approval": True,
                }
            )

        candidates.sort(key=lambda c: c["predicted_reward"], reverse=True)

        return {
            "grade": grade,
            "deviation": {k: round(v, 4) for k, v in deviation.items()},
            "base_recommendation_confidence": base.get("confidence", 0.0),
            "candidates": candidates[:top_k],
            "policy_status": self.reward_model.status(),
            "note": (
                "All candidates are advisory only. A qualified operator must "
                "review and approve before any addition is made on the floor."
            ),
        }

    # ------------------------------------------------------------------
    def _compute_reward(
        self,
        grade: str,
        composition: Dict[str, float],
        additions: Dict[str, float],
        outcome: str,
        actual_result: Optional[Dict[str, float]] = None,
    ) -> float:
        """
        Combine operator judgement with measured outcome (when available)
        into a single scalar reward in roughly [-1, 1.5].
        """
        outcome_bonus = {"accepted": 0.4, "modified": 0.0, "rejected": -0.6}.get(outcome, 0.0)

        if actual_result:
            pre_dist = _distance_to_midpoint(self.grade_generator, grade, composition)
            post_dist = _distance_to_midpoint(self.grade_generator, grade, actual_result)
            # positive if the correction moved composition closer to spec
            improvement = pre_dist - post_dist
            outcome_reward = max(-1.0, min(1.0, improvement))
        else:
            # no measured outcome yet — fall back to operator judgement only,
            # softened, since we can't confirm the real-world effect
            outcome_reward = outcome_bonus * 0.5

        cost_penalty = 0.05 * cost_of(additions)
        return outcome_bonus + outcome_reward - cost_penalty

    def record_feedback(
        self,
        grade: str,
        composition: Dict[str, float],
        additions: Dict[str, float],
        aggressiveness: float,
        outcome: str,
        actual_result: Optional[Dict[str, float]] = None,
        operator_note: Optional[str] = None,
    ) -> Dict:
        deviation = self.grade_generator.get_deviation_from_spec(grade, composition)
        reward = self._compute_reward(grade, composition, additions, outcome, actual_result)

        self.reward_model.update(deviation, grade, additions, aggressiveness, reward)
        self.reward_model.save()

        append_feedback(
            {
                "grade": grade,
                "composition": composition,
                "additions": additions,
                "aggressiveness": aggressiveness,
                "outcome": outcome,
                "actual_result": actual_result,
                "operator_note": operator_note,
                "computed_reward": reward,
            }
        )

        return {
            "accepted": True,
            "computed_reward": round(reward, 4),
            "policy_status": self.reward_model.status(),
        }

    def status(self) -> Dict:
        return self.reward_model.status()


_rl_engine: Optional[RLOptimizationEngine] = None


def get_rl_engine() -> RLOptimizationEngine:
    global _rl_engine
    if _rl_engine is None:
        _rl_engine = RLOptimizationEngine()
    return _rl_engine
