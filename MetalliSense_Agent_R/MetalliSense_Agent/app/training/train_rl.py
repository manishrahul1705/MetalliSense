"""
Offline bootstrap training for the closed-loop RL alloy optimization engine.

What this does
---------------
Before any operator has given live feedback, the Q-function has nothing
to learn from. This script warm-starts it using your existing historical
dataset (`data/dataset.csv`), so the RL engine starts from a sensible
prior instead of pure cold-start heuristics.

IMPORTANT — be honest about what "historical outcome" means here:
`dataset.csv` contains compositions and whether they were deviated, but
it does NOT contain a recorded outcome of what actually happened after a
correction was made on the floor (this repo has no such column). So this
bootstrap SIMULATES an outcome for each historical deviated sample: it
applies the supervised AlloyCorrectionAgent's recommended addition (at
3 aggressiveness levels) to the recorded composition and measures how
much closer that hypothetical correction would land you to the grade's
target midpoint, net of a cost penalty. That's a physically grounded
proxy, not a source of truth.

If/when you start logging REAL post-correction measurements in
production (recommended: add a `post_correction_composition` column to
your production log), replace or augment this script to read that
column directly instead of simulating it — at that point the "closed
loop" is powered entirely by real plant outcomes, exactly as the feature
description requires. The online `/rl/feedback` endpoint already
supports this today via its `actual_result` field.
"""
import random
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# S0-014: Ensure deterministic reproduction of RL offline bootstrap
random.seed(42)
np.random.seed(42)

sys.path.append(str(Path(__file__).parent.parent))

from config import DATASET_PATH, ELEMENTS
from data.grade_specs import GradeSpecificationGenerator
from inference.alloy_predict import get_alloy_predictor
from rl.constraints import clip_additions, cost_of
from rl.policy import AGGRESSIVENESS_LEVELS, _distance_to_midpoint, _scale_additions
from rl.reward_model import RewardModel


def bootstrap(dataset_path=None, max_rows: int = 20000):
    if dataset_path is None:
        dataset_path = DATASET_PATH

    print("=" * 60)
    print("RL ENGINE — OFFLINE BOOTSTRAP FROM HISTORICAL DATA")
    print("=" * 60)

    df = pd.read_csv(dataset_path)
    if len(df) > max_rows:
        df = df.sample(n=max_rows, random_state=42)
    print(f"Using {len(df)} historical rows")

    grade_gen = GradeSpecificationGenerator()
    alloy_predictor = get_alloy_predictor()
    reward_model = RewardModel(known_grades=grade_gen.get_available_grades())

    n_updates = 0
    total_rows = len(df)
    import time
    start_time = time.time()
    for i, (_, row) in enumerate(df.iterrows()):
        if i > 0 and i % 500 == 0:
            elapsed = time.time() - start_time
            rate = i / elapsed
            remaining = (total_rows - i) / rate if rate > 0 else 0
            print(f"  ...{i}/{total_rows} rows ({rate:.1f} rows/sec, ~{remaining:.0f}s remaining)")
        grade = row["grade"]
        if grade not in grade_gen.get_available_grades():
            continue
        composition = {el: float(row[el]) for el in ELEMENTS if el in row}
        if not composition:
            continue

        deviation = grade_gen.get_deviation_from_spec(grade, composition)
        base = alloy_predictor.predict(grade, composition)
        base_additions = base.get("recommended_additions", {}) or {}
        pre_dist = _distance_to_midpoint(grade_gen, grade, composition)

        for _, scale in AGGRESSIVENESS_LEVELS.items():
            additions = clip_additions(_scale_additions(base_additions, scale))
            simulated_result = {el: composition.get(el, 0.0) + additions.get(el, 0.0) for el in ELEMENTS}
            post_dist = _distance_to_midpoint(grade_gen, grade, simulated_result)
            improvement = pre_dist - post_dist
            reward = max(-1.0, min(1.0, improvement)) - 0.05 * cost_of(additions)

            reward_model.update(deviation, grade, additions, scale, reward)
            n_updates += 1

    reward_model.save()
    print(f"\nBootstrap complete: {n_updates} simulated (state, action, reward) updates")
    print(f"Reward model saved to {reward_model}")
    status = reward_model.status()
    print(f"Known grades: {status['known_grades']}")
    print(f"Avg reward (last 100 updates): {status['avg_reward_last_100']}")
    print("=" * 60)
    print("NOTE: this is a simulation-based bootstrap — see module docstring.")
    print("Live operator feedback via /rl/feedback continues learning from")
    print("real outcomes from this point forward.")
    print("=" * 60)


if __name__ == "__main__":
    # Optional: python train_rl.py 2000   -> use only 2000 rows for a fast demo run
    rows = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    bootstrap(max_rows=rows)
