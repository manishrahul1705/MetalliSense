# MetalliSense — Model Provenance, Data Lineage & Synthetic Limitation Notice

**Document Version:** 1.0.0  
**Repository:** MetalliSense Intelligent Foundry Decision Support System  
**Audit Baseline:** Candidate \`b196dc2c\` / \`fix/core-corrections\`

---

## 1. Executive Summary & Purpose

MetalliSense integrates machine learning (Isolation Forest anomaly detection, Gradient Boosting multi-output alloy correction, contextual bandit RL optimization, and polynomial/neural mechanical property prediction) alongside deterministic engineering calculators and physical pre-melt interlocks.

This document formally establishes the boundaries between verified software parity, algorithmic synthetic data, and physical foundry validation, in accordance with the Stage F audit requirements.

---

## 2. Dataset Provenance & Algorithmic Synthetic Lineage

### 2.1 Synthetic Dataset Nature (\`dataset.csv\`)
- **File:** \`dataset.csv\` (committed across \`MetalliSense_AI_R\`, \`MetalliSense_Agent_R\`, \`MetalliSense_Backend_Simple\`, and \`MetalliSense_VectorSearch\`)
- **Row Count:** 200,002 rows
- **Status:** **UNVERIFIED AS INDUSTRIAL PHYSICAL DATA** (Algorithmic Synthetic Dataset)
- **Data Generation Method:** Generated via statistical Monte Carlo sampling around grade specification midpoints with parameterized deviation frequencies (65% in-spec normal, 35% intentional single- and multi-element deviations).
- **Physical Foundry Attestation:** No commercial metal foundry chain-of-custody, raw Optical Emission Spectrometer (OES) photomultiplier spectral readings, or physical melt log sheets are attached.

### 2.2 Data Rights & Licensing
- **License Status:** **UNVERIFIED**
- **Attestation:** No proprietary commercial foundry non-disclosure agreements (NDAs) or formal commercial data licenses (\`LICENSE-DATA\`, Open Data Commons, or CC-BY) are asserted.
- **Classification:** The dataset serves exclusively as a simulated prototype fixture for academic publication, algorithmic validation, and demonstration.

---

## 3. Separation of Advisory AI from Mandatory Physical Gates

1. **Non-Overridable Physical Gates:**
   - Under no circumstances can AI model predictions bypass or relax mandatory physical safety interlocks.
   - Chemical composition bounds ($C_{\min}, C_{\max}, Si_{\min}, Si_{\max}, etc.$), phosphorus/sulfur impurity bans, multi-element mass dilution laws, and additive stock availability limits are evaluated and enforced by deterministic code in [\`premeltGate/calculator.js\`](file:///C:/Users/Manish/Downloads/MetalliSense-PUBLICATION-TWO-AUTHORS/MetalliSense_Backend_Simple/premeltGate/calculator.js) and [\`premeltGate/materialBalance.js\`](file:///C:/Users/Manish/Downloads/MetalliSense-PUBLICATION-TWO-AUTHORS/MetalliSense_Backend_Simple/premeltGate/materialBalance.js).
   - If an advisory model suggests additions that exceed grade caps or furnace capacity, the deterministic engine clamps or rejects the suggestion.

2. **Maker-Checker Human Authorization:**
   - AI suggestions are purely advisory proposals ($C_1, C_2, \dots, C_k$).
   - A suggestion cannot trigger additive stock deductions or furnace operations without explicit human authorization by a licensed metallurgist (\`METALLURGIST\` role) bound to exact candidate hashes and version-locked evidence (\`DEDUCT-APPROVAL-001\`).

3. **Fallback Honesty:**
   - If upstream AI sidecar services (:8000, :8001) are offline, unreachable, or timeout, the Pre-Melt Gate falls back to deterministic rule-based advice without fabricating model confidence scores or falsifying model telemetry.

---

## 4. Model Training Lineage & Evaluation Evidence Gaps

| Attribute | Verified Status | Detailed Status Description |
|:---|:---:|:---|
| **Numerical Parity** | **VERIFIED** | 6-decimal-place numerical parity between Python scikit-learn models (\`.pkl\`) and the client JavaScript evaluator (\`evaluator.js\`) is verified across all grades and test cases via [\`tests/model-fixtures.json\`](file:///C:/Users/Manish/Downloads/MetalliSense-PUBLICATION-TWO-AUTHORS/MetalliSense_Frontend_R/MetalliSense_Frontend/tests/model-fixtures.json). |
| **Negative Addition Clamping** | **VERIFIED** | Negative addition values are clamped to 0.000 kg; phosphorus and sulfur additive recommendations are strictly prohibited. |
| **Train/Validation/Test Split Manifest** | **UNVERIFIED** | No random seed manifests, cross-validation split index files, or training epoch checkpoints are committed for the serialized \`.pkl\` artifacts. |
| **Out-of-Sample Predictive Validity** | **UNVERIFIED** | No double-blind industrial trial logs, physical melt heat verification receipts, or physical tensile/hardness test coupons are attached. Industrial predictive validity on actual commercial heats is not claimed. |

---

## 5. Audit Conclusion

All AI and ML models in MetalliSense are formally classified as **ADVISORY DECISION SUPPORT PROTOTYPES**. They provide illustrative, low-latency recommendations for operator review, while all state transitions, inventory deductions, and melt releases remain governed by authenticated human authorities and deterministic physical invariants.
