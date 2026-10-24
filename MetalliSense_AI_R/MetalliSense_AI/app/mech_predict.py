"""
MetalliSense — Mechanical Property Prediction Engine
=====================================================

Maps chemistry (C, Si, Mn, P, S) to mechanical properties using
well-established metallurgical relationships for the 5 grades
in the MetalliSense dataset:

  STEELS (3 grades):
    - LOW-CARBON-STEEL    → mild steel, hot-rolled or normalized
    - MEDIUM-CARBON-STEEL → structural / machine steel
    - HIGH-CARBON-STEEL   → spring / tool steel (annealed or normalized)

  CAST IRONS (2 grades):
    - GREY-IRON → grey cast iron, flake graphite
    - SG-IRON   → spheroidal graphite (ductile) iron

Each material family uses DIFFERENT physics:
  • Steel: solid-solution + grain-size + transformation strengthening
  • Grey iron: graphite flake morphology weakens the matrix
  • SG iron: nodular graphite preserves matrix strength

Sources for the relationships used:
  - Yield strength of ferrite: Rp ≈ 160 + 40×Mn + 80×Si + 1000×P (MPa)
    (low-carbon forging steel empirical, eureka.patsnap.com)
  - Solid solution increments: Mn ~33-37 MPa/wt%, Si ~83 MPa/wt%
    (Schulte et al. 2019, ScienceDirect 2026)
  - P increment: ~365 MPa/wt% (TotalMateria)
  - Carbon equivalent: CE = C + Mn/6 + (Cr+Mo+V)/5 + (Ni+Cu)/15 (IS 1786)
  - Grey iron UTS vs CE: Collaud/Brinell-type CE relationship
  - SG iron: matrix-controlled strength, higher than grey iron

All equations include Gaussian noise to represent real-world scatter
from processing variation (rolling, cooling, casting practice).
"""

import csv
import math
import random
import os
from typing import Dict, List, Tuple

# ──────────────────────────────────────────────────────────────
# 1. CARBON EQUIVALENT (works for all grades)
# ──────────────────────────────────────────────────────────────

def carbon_equivalent(C, Mn, Si=0, Cr=0, Mo=0, V=0, Ni=0, Cu=0):
    """IS 1786 / IIW carbon equivalent formula."""
    return C + Mn / 6.0 + (Cr + Mo + V) / 5.0 + (Ni + Cu) / 15.0


# ──────────────────────────────────────────────────────────────
# 2. STEEL MECHANICAL PROPERTIES
# ──────────────────────────────────────────────────────────────

def _steel_properties(C, Si, Mn, P, S, grade, rng):
    """
    Estimate YS, UTS, elongation, hardness for carbon steels.

    Physics basis:
    - Base ferrite yield strength ≈ 160 + 40×Mn + 80×Si + 1000×P
    - Carbon strengthens through pearlite fraction and solid solution.
      For hot-rolled / normalized carbon steel, a widely used empirical:
        UTS ≈ 294 + 838×C - 452×C² + 276×Mn + 80×Si + 950×P (MPa)
      (fitted to industrial data, multiple textbook sources)
    - YS/UTS ratio typically 0.55–0.75 for carbon steels
    - Elongation decreases with C and CE
    - Hardness ≈ UTS / 3.45 (Brinell, standard approximation)
    - S reduces ductility (inclusion effect)
    """
    CE = carbon_equivalent(C, Mn)

    # --- UTS ---
    # Empirical for normalized / hot-rolled carbon steel
    uts_base = (294
                + 838 * C - 452 * C * C   # carbon: strong but diminishing
                + 276 * Mn                  # manganese
                + 80 * Si                   # silicon
                + 950 * P)                  # phosphorus (potent but limited)

    # S doesn't add strength; excessive S weakens (included in ductility)
    # Clamp to physical range
    uts_base = max(uts_base, 300)

    # Grade-specific processing factor (simulates different heat treatments)
    if grade == 'LOW-CARBON-STEEL':
        process_factor = 1.0
        noise_sd = 18  # ±18 MPa scatter from rolling/cooling variation
    elif grade == 'MEDIUM-CARBON-STEEL':
        process_factor = 1.0
        noise_sd = 25
    else:  # HIGH-CARBON-STEEL
        # Normalized or annealed; very high C steels (>1%) are typically
        # softer when annealed (spheroidized) than the formula gives.
        if C > 0.8:
            process_factor = 0.85 + 0.15 * math.exp(-(C - 0.8) * 3)
        else:
            process_factor = 1.0
        noise_sd = 30

    uts = uts_base * process_factor + rng.gauss(0, noise_sd)
    uts = max(uts, 280)

    # --- YS ---
    ys_base = 160 + 40 * Mn + 80 * Si + 1000 * P
    # Carbon contribution to YS (through pearlite/transformation)
    ys_base += 500 * C * (1 - 0.5 * C)  # diminishing at high C
    ys = ys_base + rng.gauss(0, noise_sd * 0.7)
    # YS must be < UTS; typical ratio 0.55-0.75
    if ys >= uts * 0.92:
        ys = uts * (0.60 + rng.gauss(0, 0.04))
    ys = max(ys, 200)
    ys = min(ys, uts * 0.90)

    # --- Elongation ---
    # Decreases with C and CE; S reduces it further
    # Adjusted: real normalized steels retain more ductility than
    # the simple linear model suggests, especially at moderate C.
    elong_base = 45 - 35 * C - 12 * C * C - 5 * CE - 120 * S
    if grade == 'HIGH-CARBON-STEEL' and C > 0.6:
        # Annealed/spheroidized high-C steels retain reasonable ductility
        elong_base = max(elong_base, 12 - 5 * (C - 0.6))
    elong = elong_base + rng.gauss(0, 2.0)
    elong = max(elong, 2.0)
    elong = min(elong, 45.0)

    # --- Hardness (Brinell) ---
    hb = uts / 3.45 + rng.gauss(0, 5)
    hb = max(hb, 80)

    # --- UTS/YS ratio ---
    uts_ys_ratio = uts / ys if ys > 0 else 1.5

    return uts, ys, elong, hb, uts_ys_ratio, CE


# ──────────────────────────────────────────────────────────────
# 3. GREY IRON MECHANICAL PROPERTIES
# ──────────────────────────────────────────────────────────────

def _grey_iron_properties(C, Si, Mn, P, S, rng):
    """
    Grey cast iron tensile strength from chemistry.

    Physics basis:
    - Carbon equivalent for cast iron: CE_iron = C + Si/3 + P/3
      (different formula from steel CE)
    - Higher CE → more graphite → weaker (graphite flakes act as cracks)
    - UTS decreases roughly linearly with CE above the eutectic (~4.3%)
    - Typical grey iron UTS: 150–350 MPa
    - Mn strengthens the pearlite matrix
    - S weakens by forming FeS films (but usually controlled with Mn)
    - Grey iron has essentially NO measurable yield point (brittle);
      we report 0.1% proof stress ≈ 0.65–0.85 × UTS
    - Elongation is very low: 0.3–0.8% typical
    - Hardness: 150–280 HB
    """
    CE_iron = C + Si / 3.0 + P / 3.0

    # UTS model (empirical, multiple foundry sources)
    # Base: ~880 - 125 × CE_iron, adjusted for Mn
    uts_base = 880 - 125 * CE_iron + 35 * Mn
    # S penalty
    uts_base -= 300 * max(S - 0.05, 0)
    uts = uts_base + rng.gauss(0, 15)
    uts = max(uts, 100)
    uts = min(uts, 400)

    # 0.1% proof stress (grey iron doesn't have a clear YS)
    ys = uts * (0.72 + rng.gauss(0, 0.03))
    ys = max(ys, 80)
    ys = min(ys, uts * 0.90)

    # Elongation — very low for grey iron
    elong = 0.5 + rng.gauss(0, 0.15)
    elong = max(elong, 0.1)
    elong = min(elong, 1.5)

    # Hardness
    hb = 100 + 35 * (4.5 - CE_iron) + 20 * Mn + rng.gauss(0, 8)
    hb = max(hb, 130)
    hb = min(hb, 300)

    uts_ys_ratio = uts / ys if ys > 0 else 1.3

    return uts, ys, elong, hb, uts_ys_ratio, CE_iron


# ──────────────────────────────────────────────────────────────
# 4. SG (DUCTILE) IRON MECHANICAL PROPERTIES
# ──────────────────────────────────────────────────────────────

def _sg_iron_properties(C, Si, Mn, P, S, rng):
    """
    SG (ductile) iron mechanical properties from chemistry.

    Physics basis:
    - Graphite is nodular (spheroidal), not flake → much less weakening
    - Matrix can be ferritic, pearlitic or mixed depending on Si, Mn, Cu
    - Si is a strong ferrite promoter → more ferrite → lower strength,
      higher ductility
    - Mn promotes pearlite → higher strength, lower ductility
    - C above ~3.6% → more graphite nodules but matrix weakens slightly
    - P must be very low (<0.05%) to avoid embrittlement
    - S must be <0.02% for good nodularity (Mg treatment)

    Typical ranges:
      Ferritic (high Si, low Mn): UTS 380–450, YS 240–300, Elong 15–22%
      Pearlitic (higher Mn):      UTS 550–700, YS 350–450, Elong 3–7%
      Mixed:                      UTS 450–550, YS 300–380, Elong 7–15%
    """
    CE_iron = C + Si / 3.0 + P / 3.0

    # Pearlite fraction estimate (0 = fully ferritic, 1 = fully pearlitic)
    # Si suppresses pearlite; Mn promotes it
    pearlite_frac = 0.15 + 0.45 * Mn - 0.15 * Si
    pearlite_frac = max(0.0, min(1.0, pearlite_frac))

    # UTS
    uts_ferritic = 370 + 40 * Si  # Si strengthens ferrite
    uts_pearlitic = 650 + 50 * Mn
    uts_base = uts_ferritic * (1 - pearlite_frac) + uts_pearlitic * pearlite_frac

    # P penalty (embrittlement above 0.05%)
    if P > 0.05:
        uts_base -= 500 * (P - 0.05)

    # S penalty (poor nodularity if S > 0.02%)
    if S > 0.02:
        uts_base -= 800 * (S - 0.02)

    uts = uts_base + rng.gauss(0, 20)
    uts = max(uts, 300)
    uts = min(uts, 800)

    # YS
    ys_ratio = 0.65 - 0.1 * pearlite_frac + rng.gauss(0, 0.02)
    ys_ratio = max(0.55, min(0.75, ys_ratio))
    ys = uts * ys_ratio
    ys = max(ys, 200)

    # Elongation — decreases with pearlite, increases with Si
    elong_base = 22 - 18 * pearlite_frac + 1.5 * Si - 200 * max(P - 0.03, 0)
    elong = elong_base + rng.gauss(0, 1.5)
    elong = max(elong, 1.0)
    elong = min(elong, 25.0)

    # Hardness
    hb = 130 + 120 * pearlite_frac + 15 * Si + rng.gauss(0, 8)
    hb = max(hb, 130)
    hb = min(hb, 320)

    uts_ys_ratio = uts / ys if ys > 0 else 1.4

    return uts, ys, elong, hb, uts_ys_ratio, CE_iron


# ──────────────────────────────────────────────────────────────
# 5. QUALITY CHECKS (rule-based, all grades)
# ──────────────────────────────────────────────────────────────

# Reference standards for pass/fail
MECH_STANDARDS = {
    'LOW-CARBON-STEEL': {
        'uts_min': 370, 'ys_min': 230, 'elong_min': 20, 'hb_max': 200,
        'ce_max': 0.42, 'sp_max': 0.080,
        'ref': 'IS 2062 E250 (indicative)'
    },
    'MEDIUM-CARBON-STEEL': {
        'uts_min': 550, 'ys_min': 300, 'elong_min': 10, 'hb_max': 320,
        'ce_max': 0.65, 'sp_max': 0.080,
        'ref': 'IS 1570 C30-C60 range (indicative)'
    },
    'HIGH-CARBON-STEEL': {
        'uts_min': 650, 'ys_min': 350, 'elong_min': 5, 'hb_max': 380,
        'ce_max': None, 'sp_max': 0.070,
        'ref': 'IS 1570 C60-C100 annealed/normalized (indicative)'
    },
    'GREY-IRON': {
        'uts_min': 200, 'ys_min': None, 'elong_min': None, 'hb_max': 280,
        'ce_max': None, 'sp_max': None,
        'ref': 'IS 210 FG 200 (indicative)'
    },
    'SG-IRON': {
        'uts_min': 400, 'ys_min': 250, 'elong_min': 10, 'hb_max': 280,
        'ce_max': None, 'sp_max': 0.085,
        'ref': 'IS 1865 SG 400/10 (indicative)'
    },
}


def quality_checks(grade, C, Si, Mn, P, S, uts, ys, elong, hb, CE):
    """Rule-based quality alerts."""
    std = MECH_STANDARDS.get(grade, {})
    alerts = []
    pass_fail = 'PASS'

    if std.get('uts_min') and uts < std['uts_min']:
        alerts.append({
            'type': 'FAIL', 'property': 'UTS',
            'message': f"UTS {uts:.0f} MPa below minimum {std['uts_min']} MPa",
            'severity': 'HIGH'
        })
        pass_fail = 'FAIL'

    if std.get('ys_min') and ys < std['ys_min']:
        alerts.append({
            'type': 'FAIL', 'property': 'YS',
            'message': f"YS {ys:.0f} MPa below minimum {std['ys_min']} MPa",
            'severity': 'HIGH'
        })
        pass_fail = 'FAIL'

    if std.get('elong_min') and elong < std['elong_min']:
        alerts.append({
            'type': 'FAIL', 'property': 'Elongation',
            'message': f"Elongation {elong:.1f}% below minimum {std['elong_min']}%",
            'severity': 'HIGH'
        })
        pass_fail = 'FAIL'

    if std.get('hb_max') and hb > std['hb_max']:
        alerts.append({
            'type': 'WARN', 'property': 'Hardness',
            'message': f"Hardness {hb:.0f} HB above max {std['hb_max']} HB",
            'severity': 'MEDIUM'
        })

    if std.get('ce_max') and CE > std['ce_max']:
        alerts.append({
            'type': 'FAIL', 'property': 'CE',
            'message': f"Carbon equivalent {CE:.3f} exceeds limit {std['ce_max']}",
            'severity': 'HIGH'
        })
        pass_fail = 'FAIL'

    sp = P + S
    if std.get('sp_max') and sp > std['sp_max']:
        alerts.append({
            'type': 'FAIL', 'property': 'S+P',
            'message': f"S+P = {sp:.4f} exceeds limit {std['sp_max']}",
            'severity': 'HIGH'
        })
        pass_fail = 'FAIL'

    # Weldability warning for steels
    if grade in ('LOW-CARBON-STEEL', 'MEDIUM-CARBON-STEEL') and CE > 0.40:
        alerts.append({
            'type': 'WARN', 'property': 'Weldability',
            'message': f"CE {CE:.3f} above 0.40 — weldability reduced",
            'severity': 'MEDIUM'
        })

    # Ductility warning for SG iron
    if grade == 'SG-IRON' and S > 0.025:
        alerts.append({
            'type': 'WARN', 'property': 'Nodularity',
            'message': f"S = {S:.4f} above 0.025 — nodularity may be poor",
            'severity': 'MEDIUM'
        })

    if not alerts:
        alerts.append({
            'type': 'PASS', 'property': 'All',
            'message': 'All mechanical properties within expected range',
            'severity': 'NONE'
        })

    return pass_fail, alerts


# ──────────────────────────────────────────────────────────────
# 6. MAIN PREDICTION FUNCTION
# ──────────────────────────────────────────────────────────────

def predict_mechanical(grade: str, C: float, Si: float, Mn: float,
                       P: float, S: float, seed=None) -> Dict:
    """
    Predict mechanical properties from chemistry for any MetalliSense grade.

    Returns dict with: uts, ys, elongation, hardness_hb, uts_ys_ratio,
    carbon_equivalent, ce_budget (breakdown), quality_result, alerts,
    and element_contributions (which element contributes how much to strength).
    """
    rng = random.Random(seed)

    is_steel = grade in ('LOW-CARBON-STEEL', 'MEDIUM-CARBON-STEEL', 'HIGH-CARBON-STEEL')

    if is_steel:
        uts, ys, elong, hb, ratio, CE = _steel_properties(C, Si, Mn, P, S, grade, rng)
    elif grade == 'GREY-IRON':
        uts, ys, elong, hb, ratio, CE = _grey_iron_properties(C, Si, Mn, P, S, rng)
    elif grade == 'SG-IRON':
        uts, ys, elong, hb, ratio, CE = _sg_iron_properties(C, Si, Mn, P, S, rng)
    else:
        raise ValueError(f"Unknown grade: {grade}")

    pass_fail, alerts = quality_checks(grade, C, Si, Mn, P, S, uts, ys, elong, hb, CE)

    # CE budget breakdown based on material family
    if is_steel:
        ce_val = carbon_equivalent(C, Mn)
        ce_budget = {
            'C': {'value': C, 'contribution': round(C, 4), 'share_pct': round(C / ce_val * 100, 1) if ce_val > 0 else 0},
            'Mn/6': {'value': Mn, 'contribution': round(Mn / 6.0, 4), 'share_pct': round((Mn / 6.0) / ce_val * 100, 1) if ce_val > 0 else 0},
        }
    else:
        ce_val = C + (Si + P) / 3.0
        ce_budget = {
            'C': {'value': C, 'contribution': round(C, 4), 'share_pct': round(C / ce_val * 100, 1) if ce_val > 0 else 0},
            'Si/3': {'value': Si, 'contribution': round(Si / 3.0, 4), 'share_pct': round((Si / 3.0) / ce_val * 100, 1) if ce_val > 0 else 0},
            'P/3': {'value': P, 'contribution': round(P / 3.0, 4), 'share_pct': round((P / 3.0) / ce_val * 100, 1) if ce_val > 0 else 0},
        }

    # Element contributions to UTS (approximate, for explainability)
    if is_steel:
        c_contrib = 838 * C - 452 * C * C
        mn_contrib = 276 * Mn
        si_contrib = 80 * Si
        p_contrib = 950 * P
        base_contrib = 294
        total = base_contrib + c_contrib + mn_contrib + si_contrib + p_contrib
        contributions = {
            'base_ferrite': {'mpa': round(base_contrib, 1), 'pct': round(base_contrib / total * 100, 1)},
            'C': {'mpa': round(c_contrib, 1), 'pct': round(c_contrib / total * 100, 1)},
            'Mn': {'mpa': round(mn_contrib, 1), 'pct': round(mn_contrib / total * 100, 1)},
            'Si': {'mpa': round(si_contrib, 1), 'pct': round(si_contrib / total * 100, 1)},
            'P': {'mpa': round(p_contrib, 1), 'pct': round(p_contrib / total * 100, 1)},
        }
    else:
        contributions = {'note': 'Cast iron strength is matrix + graphite morphology controlled; per-element breakdown not applicable.'}

    return {
        'grade': grade,
        'material_family': 'steel' if is_steel else 'cast_iron',
        'predicted_uts_mpa': round(uts, 1),
        'predicted_ys_mpa': round(ys, 1),
        'predicted_elongation_pct': round(elong, 1),
        'predicted_hardness_hb': round(hb, 0),
        'uts_ys_ratio': round(ratio, 3),
        'carbon_equivalent': round(CE, 4),
        'ce_budget': ce_budget,
        'element_contributions': contributions,
        'quality_result': pass_fail,
        'alerts': alerts,
        'reference_standard': MECH_STANDARDS.get(grade, {}).get('ref', 'N/A'),
        'confidence_note': 'Estimated from chemistry using published empirical relationships. '
                           'Actual values depend on processing (rolling/cooling/casting practice). '
                           'Prediction improves when calibrated against plant UTM data.',
    }


# ──────────────────────────────────────────────────────────────
# 7. ENRICH THE FULL DATASET
# ──────────────────────────────────────────────────────────────

def enrich_dataset(input_csv: str, output_csv: str, seed=42):
    """
    Read the MetalliSense dataset.csv and write a new CSV with
    mechanical property columns added.
    """
    rng_seed = seed

    with open(input_csv, newline='') as fin:
        reader = csv.DictReader(fin)
        original_fields = reader.fieldnames

        new_fields = original_fields + [
            'UTS_MPa', 'YS_MPa', 'Elongation_pct', 'Hardness_HB',
            'UTS_YS_ratio', 'Carbon_Equivalent', 'Mech_Quality'
        ]

        with open(output_csv, 'w', newline='') as fout:
            writer = csv.DictWriter(fout, fieldnames=new_fields)
            writer.writeheader()

            count = 0
            for row in reader:
                result = predict_mechanical(
                    grade=row['grade'],
                    C=float(row['C']),
                    Si=float(row['Si']),
                    Mn=float(row['Mn']),
                    P=float(row['P']),
                    S=float(row['S']),
                    seed=rng_seed + count,
                )
                row['UTS_MPa'] = result['predicted_uts_mpa']
                row['YS_MPa'] = result['predicted_ys_mpa']
                row['Elongation_pct'] = result['predicted_elongation_pct']
                row['Hardness_HB'] = result['predicted_hardness_hb']
                row['UTS_YS_ratio'] = result['uts_ys_ratio']
                row['Carbon_Equivalent'] = result['carbon_equivalent']
                row['Mech_Quality'] = result['quality_result']
                writer.writerow(row)
                count += 1
                if count % 50000 == 0:
                    print(f"  Processed {count:,} rows...")

    print(f"Done: {count:,} rows written to {output_csv}")
    return count


if __name__ == '__main__':
    # --- Quick demo ---
    print("="*70)
    print("MetalliSense Mechanical Property Prediction — Demo")
    print("="*70)

    demos = [
        ('LOW-CARBON-STEEL',    0.15, 0.30, 0.60, 0.025, 0.030),
        ('MEDIUM-CARBON-STEEL', 0.45, 0.35, 1.00, 0.025, 0.030),
        ('HIGH-CARBON-STEEL',   1.00, 0.50, 1.20, 0.025, 0.030),
        ('GREY-IRON',           3.20, 1.80, 0.80, 0.080, 0.070),
        ('SG-IRON',             3.50, 2.30, 0.65, 0.040, 0.015),
        # Deviated cases
        ('LOW-CARBON-STEEL',    0.35, 0.60, 1.10, 0.055, 0.060),  # high everything
        ('SG-IRON',             3.80, 1.50, 1.10, 0.090, 0.040),  # high P, high S
    ]

    for grade, C, Si, Mn, P, S in demos:
        r = predict_mechanical(grade, C, Si, Mn, P, S, seed=99)
        status = '✅' if r['quality_result'] == 'PASS' else '❌'
        print(f"\n{status} {grade}  C={C} Si={Si} Mn={Mn} P={P} S={S}")
        print(f"   UTS={r['predicted_uts_mpa']} MPa  YS={r['predicted_ys_mpa']} MPa  "
              f"Elong={r['predicted_elongation_pct']}%  HB={r['predicted_hardness_hb']}  "
              f"CE={r['carbon_equivalent']:.3f}")
        for a in r['alerts']:
            icon = '🔴' if a['severity'] == 'HIGH' else '🟡' if a['severity'] == 'MEDIUM' else '🟢'
            print(f"   {icon} {a['message']}")
