"""
Real-world manufacturing constraints for the RL alloy optimization engine.

These are deliberately conservative, hand-editable defaults — in a real
deployment these should come from the plant's process engineering specs
(furnace capacity, alloy inventory, cost per kg, safety limits) rather
than being hardcoded. They're kept in one place so operators/engineers
can tune them without touching the RL logic itself.
"""
from __future__ import annotations

from typing import Dict

from config import ELEMENTS, MAX_ADDITION_PERCENTAGE

# Maximum single-element addition per correction pass (percentage points).
# Individual elements can further restrict this (e.g. phosphorus/sulfur
# are trace elements and should never be bulk-added the way Fe/C/Si can).
ELEMENT_MAX_ADDITION = {
    "Fe": MAX_ADDITION_PERCENTAGE,
    "C": 1.5,
    "Si": 1.5,
    "Mn": 1.0,
    "P": 0.05,
    "S": 0.05,
}

# Relative cost per unit addition, used purely to bias the policy toward
# cheaper corrections when two candidates are otherwise equally effective.
# Values are illustrative relative weights, not real currency.
ELEMENT_COST_WEIGHT = {
    "Fe": 1.0,
    "C": 2.0,
    "Si": 3.0,
    "Mn": 4.0,
    "P": 6.0,
    "S": 6.0,
}

# Maximum total mass fraction that may be added across all elements in a
# single correction pass — models furnace/ladle physical limits.
MAX_TOTAL_ADDITION = 6.0


def clip_additions(additions: Dict[str, float]) -> Dict[str, float]:
    """Clip a candidate correction to per-element and total safety bounds.
    
    S0-013: Coreless induction melting furnaces cannot physically subtract
    alloys from a liquid melt. Additions must be strictly non-negative (>= 0).
    """
    clipped = {}
    for el in ELEMENTS:
        val = float(additions.get(el, 0.0))
        limit = ELEMENT_MAX_ADDITION.get(el, MAX_ADDITION_PERCENTAGE)
        clipped[el] = max(0.0, min(limit, val))

    total = sum(v for v in clipped.values())
    if total > MAX_TOTAL_ADDITION and total > 0:
        scale = MAX_TOTAL_ADDITION / total
        clipped = {el: v * scale for el, v in clipped.items()}
    return clipped


def constraint_violations(additions: Dict[str, float]) -> Dict[str, str]:
    """Return a dict of {element: reason} for any bound that was hit."""
    violations = {}
    for el in ELEMENTS:
        val = float(additions.get(el, 0.0))
        limit = ELEMENT_MAX_ADDITION.get(el, MAX_ADDITION_PERCENTAGE)
        if val >= limit - 1e-9:
            violations[el] = f"Hit max single-pass addition limit ({limit}%)"
    total = sum(float(v) for v in additions.values())
    if total >= MAX_TOTAL_ADDITION - 1e-9:
        violations["_total"] = f"Hit max total addition limit ({MAX_TOTAL_ADDITION}%)"
    return violations


def cost_of(additions: Dict[str, float]) -> float:
    return sum(float(v) * ELEMENT_COST_WEIGHT.get(el, 1.0) for el, v in additions.items())
