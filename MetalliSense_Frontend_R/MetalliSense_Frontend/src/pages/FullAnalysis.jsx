import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Workflow, ThumbsUp, ThumbsDown, AlertTriangle, ShieldCheck, Gauge, Lock, CheckCircle2 } from "lucide-react";
import GateBanner from "../components/premelt/GateBanner";
import { useMeltFlow } from "../context/MeltFlowContext";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import Badge from "../components/common/Badge";
import SyntheticGenerator from "../components/common/SyntheticGenerator";
import { runFullAnalysis } from "../services/workflowService";
import { rlSubmitFeedback } from "../services/rlService";
import { deductAdditives, evaluateCorrection, approveCorrection } from "../services/premeltService";
import { errMsg } from "../components/premelt/premeltUi";
import toast from "react-hot-toast";
import { MeltSpinner } from "../components/common/FurnaceLoader";

const severityVariant = { LOW: "success", MEDIUM: "warning", HIGH: "danger", none: "success", mild: "warning", moderate: "warning", severe: "danger" };
const strategyColor = { conservative: "default", balanced: "warning", aggressive: "danger" };

const FA_MECH_STANDARDS = {
  "LOW-CARBON-STEEL":    { uts_min: 370, ys_min: 230, elong_min: 20, hb_max: 200, ce_max: 0.42, sp_max: 0.080 },
  "MEDIUM-CARBON-STEEL": { uts_min: 550, ys_min: 300, elong_min: 10, hb_max: 320, ce_max: 0.65, sp_max: 0.080 },
  "HIGH-CARBON-STEEL":   { uts_min: 650, ys_min: 350, elong_min: 5,  hb_max: 380, ce_max: null, sp_max: 0.070 },
  "GREY-IRON":           { uts_min: 200, ys_min: null, elong_min: null, hb_max: 280, ce_max: null, sp_max: null },
  "SG-IRON":             { uts_min: 400, ys_min: 250, elong_min: 10, hb_max: 280, ce_max: null, sp_max: 0.085 },
};

function faPredictMech(grade, C, Si, Mn, P, S) {
  const g = (grade || "").toUpperCase();
  const isSteel = g.includes("STEEL");
  const isGrey = g === "GREY-IRON";
  let uts, ys, elong, hb, ce;
  if (isSteel) {
    ce = C + Mn / 6;
    uts = Math.max(280, 294 + 838*C - 452*C*C + 276*Mn + 80*Si + 950*P);
    if (g === "HIGH-CARBON-STEEL" && C > 0.8) uts *= 0.85+0.15*Math.exp(-(C-0.8)*3);
    ys = 160 + 40*Mn + 80*Si + 1000*P + 500*C*(1-0.5*C);
    if (ys >= uts*0.92) ys = uts*0.62;
    ys = Math.min(ys, uts*0.9);
    elong = Math.max(2, Math.min(45, 45 - 35*C - 12*C*C - 5*ce - 120*S));
    hb = uts / 3.45;
  } else if (isGrey) {
    ce = C + Si/3 + P/3;
    uts = Math.max(100, Math.min(400, 880 - 125*ce + 35*Mn));
    ys = uts*0.72; elong = 0.5; hb = 100 + 35*(4.5-ce) + 20*Mn;
  } else {
    ce = C + Si/3 + P/3;
    let pf = Math.max(0, Math.min(1, 0.15+0.45*Mn-0.15*Si));
    uts = Math.max(300, Math.min(800, (370+40*Si)*(1-pf)+(650+50*Mn)*pf));
    if (P>0.05) uts -= 500*(P-0.05); if (S>0.02) uts -= 800*(S-0.02);
    ys = uts*(0.65-0.1*pf);
    elong = Math.max(1, Math.min(25, 22-18*pf+1.5*Si-200*Math.max(P-0.03,0)));
    hb = 130+120*pf+15*Si;
  }
  const std = FA_MECH_STANDARDS[g] || {};
  let pass = true;
  if (std.uts_min && uts < std.uts_min) pass = false;
  if (std.ys_min && ys < std.ys_min) pass = false;
  if (std.elong_min && elong < std.elong_min) pass = false;
  if (std.ce_max && ce > std.ce_max) pass = false;
  if (std.sp_max && (P+S) > std.sp_max) pass = false;
  return { uts: Math.round(uts), ys: Math.round(ys), elong: +elong.toFixed(1), hb: Math.round(hb), ce: +ce.toFixed(3), pass };
}

// The connected, single-flow experience: generate/read one composition,
// and see Anomaly Detection -> Alloy Recommendation -> Closed-Loop RL ->
// Cost & Carbon analysis all together, from one backend call
// (/api/v2/workflow/full-analysis) — no re-entering data between pages.
export default function FullAnalysis() {
  const navigate = useNavigate();
  const { flow, isUnlocked, acceptStrategy } = useMeltFlow();
  const [reading, setReading] = useState(null);
  const [batchWeightKg, setBatchWeightKg] = useState(1000);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(null);
  // Once one strategy is accepted, the other two are frozen.
  const [chosenStrategy, setChosenStrategy] = useState(null);
  const [approvedStrategies, setApprovedStrategies] = useState({});

  // When a heat passes the gate, pre-fill everything from the gate result.
  // Priority: alloy result reading → anomaly result reading → gate composition direct.
  useEffect(() => {
    if (isUnlocked && !reading) {
      const alloyReading = flow.alloyResult?._reading;
      const anomalyReading = flow.anomalyResult?._reading;
      const src = alloyReading || anomalyReading || (flow.predictedComposition ? {
        metalGrade: flow.grade,
        composition: flow.predictedComposition,
        sigma: flow.compositionSigma || {},
        deviationElements: flow.deviationElements || [],
        temperature: 1480,
        pressure: 1,
        source: `gate_prediction_${flow.gateId}`,
        heatId: flow.heatId,
      } : null);
      if (src) {
        setReading(src);
        // Auto-set batch weight to actual charge kg from gate
        if (flow.chargeKg) setBatchWeightKg(Math.round(flow.chargeKg));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnlocked]);

  const handleGenerate = (r) => {
    setReading(r);
    setResult(null);
    setChosenStrategy(null);
  };

  const handleRunAnalysis = async () => {
    if (!reading) {
      toast.error("Generate a reading first");
      return;
    }
    setLoading(true);
    try {
      const res = await runFullAnalysis({
        metalGrade: reading.metalGrade,
        composition: reading.composition,
        batchWeightKg,
        topK: 3,
      });
      setResult(res.data.data);
      setChosenStrategy(null);
      toast.success("Full analysis complete");
    } catch (err) {
      console.error("Full analysis failed:", err);
      toast.error(err.response?.data?.message || "Analysis failed — are the AI/Agent services running?");
    } finally {
      setLoading(false);
    }
  };

  const handleApproveStrategy = async (candidate) => {
    if (!flow?.heatId) {
      toast.error("No active heat in flow context");
      return;
    }
    setSubmitting(candidate.strategy);
    try {
      const gateAdditions = flow.suggestedAdditions || [];
      const lines = gateAdditions
        .filter(a => a.lotId && a.kg > 0)
        .map(a => ({
          lotId: a.lotId,
          kg: a.kg,
          heatId: flow.heatId,
          by: "metallurgist",
          alloyName: a.alloyName,
        }));

      const evalRes = await evaluateCorrection({
        heatId: flow.heatId,
        additions: lines,
        targetGrade: flow.grade
      });

      const candidateHash = evalRes.data?.data?.candidateHash || evalRes.data?.candidateHash || "mock-hash";
      const candidateId = `CAND-${candidate.strategy.toUpperCase()}`;

      await approveCorrection({
        heatId: flow.heatId,
        candidateId,
        candidateHash,
        expectedHeatVersion: flow.version || 1,
        evidenceVersion: reading?.sampleId || `SMP-${flow.heatId}`,
        specVersion: "1.0",
        additions: lines,
        makerId: flow.plannedBy || "planner1"
      });

      setApprovedStrategies(prev => ({ ...prev, [candidate.strategy]: true }));
      toast.success(`✅ Strategy "${candidate.strategy}" approved (Maker-Checker Verified)`);
    } catch (err) {
      console.error("Approval failed:", err);
      toast.error(err.response?.data?.message || err.message || "Failed to approve correction");
    } finally {
      setSubmitting(null);
    }
  };

  const handleFeedback = async (candidate, outcome) => {
    if (!reading || chosenStrategy || submitting) return;
    setSubmitting(candidate.strategy);
    try {
      if (import.meta.env.VITE_MOCK_MODE === 'true' && outcome === 'accepted' && isUnlocked && flow.heatId) {
        const r = await fetch('/__mock/accept-strategy', {method:'POST',body:JSON.stringify({heatId:flow.heatId,candidate,composition:reading.composition})});
        const j = await r.json();
        if (!r.ok) throw new Error(j.message);
        acceptStrategy(j.data);
        toast.success('Strategy accepted — selected quantities deducted. Policy updated.');
        setChosenStrategy(candidate.strategy);
        return;
      }
      await rlSubmitFeedback({
        heatId: flow?.heatId || undefined,
        grade: reading.metalGrade,
        composition: reading.composition,
        additions: candidate.recommended_additions,
        aggressiveness: candidate.aggressiveness,
        outcome,
        operatorNote: `Operator ${outcome} the "${candidate.strategy}" strategy from Full Analysis`,
      });
      if (outcome === "accepted") {
        if (isUnlocked && flow.heatId) {
          const idempotencyKey = typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `deduct-${flow.heatId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const gateAdditions = flow.suggestedAdditions || [];
          const lines = gateAdditions
            .filter(a => a.lotId && a.kg > 0)
            .map(a => ({
              lotId: a.lotId,
              kg: a.kg,
              heatId: flow.heatId,
              by: 'operator',
              alloyName: a.alloyName,
            }));

          if (lines.length > 0) {
            try {
              const candidateId = candidate.strategy ? `CAND-${candidate.strategy.toUpperCase()}` : undefined;
            await deductAdditives(lines, { idempotencyKey, heatId: flow.heatId, candidateId });
            } catch (deductErr) {
              console.error("Deduction error in full analysis:", deductErr);
              toast.error(`Stock deduction failed: ${errMsg(deductErr)}`);
              setSubmitting(null);
              return;
            }
          }
          acceptStrategy({ ...candidate, deductedLines: lines });
          setChosenStrategy(candidate.strategy);
          toast.success(`✅ Strategy accepted — stock deducted. Proceed to Mechanical Properties.`);
        } else {
          setChosenStrategy(candidate.strategy);
          toast.success(`Feedback recorded (${outcome})`);
        }
      } else {
        toast.success(`Feedback recorded (${outcome})`);
      }
    } catch (err) {
      console.error("Feedback failed:", err);
      toast.error(err.response?.data?.message || err.message || "Failed to record feedback");
    } finally {
      setSubmitting(null);
    }
  };

  const steps = result?.steps;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <GateBanner page="anomaly" />
      {isUnlocked && reading && (
        <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-3 flex items-center gap-2 text-sm text-emerald-900">
          <ShieldCheck size={14} />
          <span>Using gate-predicted composition for Heat <strong>{flow.heatId}</strong> ({flow.grade}). Run Full Analysis to see all AI steps at once.</span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Workflow className="text-emerald-600" size={28} />
        <div>
          <h1 className="text-2xl font-bold text-metal-900">Full Analysis</h1>
          <p className="text-metal-500 text-sm">
            One composition, one click — Composition Deviation Analysis → Melt Correction Planner → Adaptive Strategy Optimizer → Cost &amp; Carbon
          </p>
        </div>
      </div>

      {/* Show synthetic generator only when NOT in gate flow, or as override */}
      {!isUnlocked && (
        <SyntheticGenerator onDataGenerated={handleGenerate} buttonText="Generate Reading" />
      )}

      {reading && (
        <Card>
          {isUnlocked && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 mb-4 text-sm">
              <div className="font-semibold text-emerald-900 mb-2">Gate-sourced inputs — Heat {flow.heatId} · {flow.grade}</div>
              <div className="grid sm:grid-cols-3 gap-3 text-xs">
                <div className="bg-white rounded-lg p-3 border border-emerald-100">
                  <div className="text-metal-500 mb-1">Batch charged</div>
                  <div className="text-xl font-bold text-metal-900">{flow.chargeKg ? `${Math.round(flow.chargeKg)} kg` : `${batchWeightKg} kg`}</div>
                  <div className="text-metal-500">→ ~{flow.metalKg ? Math.round(flow.metalKg) : Math.round(batchWeightKg * 0.95)} kg metal</div>
                </div>
                <div className="bg-white rounded-lg p-3 border border-emerald-100">
                  <div className="text-metal-500 mb-1">Predicted composition (gate)</div>
                  {Object.entries(reading.composition || {}).filter(([el]) => ['C','Si','Mn','P','S'].includes(el)).map(([el,v]) => (
                    <span key={el} className={`inline-block mr-2 font-mono text-[11px] font-semibold ${(reading.deviationElements || []).includes(el) ? 'text-amber-700 bg-amber-50 px-1 rounded' : 'text-metal-700'}`}>
                      {el} {Number(v).toFixed(3)}%
                    </span>
                  ))}
                </div>
                <div className="bg-white rounded-lg p-3 border border-emerald-100">
                  <div className="text-metal-500 mb-1">Deviation elements</div>
                  {(reading.deviationElements || flow.deviationElements || []).length === 0
                    ? <span className="text-emerald-700 font-semibold">All elements in spec ✓</span>
                    : (reading.deviationElements || flow.deviationElements).map(el => (
                        <span key={el} className="inline-block bg-amber-100 text-amber-800 font-bold rounded px-2 py-0.5 text-xs mr-1">{el}</span>
                      ))
                  }
                </div>
              </div>
              {(flow.anomalyResult || flow.alloyResult) && (
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-metal-600">
                  {flow.anomalyResult && <span>Anomaly: <strong className={flow.anomalyResult.severity==='NORMAL'?'text-emerald-700':'text-amber-700'}>{flow.anomalyResult.severity||'NORMAL'}</strong> (score {(flow.anomalyResult.anomaly_score||0).toFixed(3)})</span>}
                  {flow.alloyResult?.aiAnalysis?.confidence && <span>Alloy confidence: <strong className="text-emerald-700">{((flow.alloyResult.aiAnalysis.confidence||0)*100).toFixed(0)}%</strong></span>}
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <label className="text-xs text-metal-500 block mb-1">Batch weight (kg)</label>
              <input
                type="number"
                min="1"
                value={batchWeightKg}
                onChange={(e) => setBatchWeightKg(parseFloat(e.target.value) || 1000)}
                className="border border-metal-200 rounded-lg px-3 py-2 w-32 text-sm"
              />
            </div>
            {isUnlocked && (
              <details className="mt-4 text-xs text-metal-500 cursor-pointer">
                <summary className="hover:text-metal-700 font-semibold">Chemist override — use different composition</summary>
                <div className="mt-2"><SyntheticGenerator onDataGenerated={handleGenerate} buttonText="Enter manually" /></div>
              </details>
            )}
            <Button onClick={handleRunAnalysis} loading={loading} className="mt-5">
              Run Full Analysis
            </Button>
          </div>
        </Card>
      )}

      {loading && (
        <Card>
          <MeltSpinner label="Running the full melt analysis…" sublabel="Deviation → Correction → Strategy → Cost & carbon" />
        </Card>
      )}

      {steps && (
        <>
          {/* Step 1: Anomaly Detection */}
          <Card>
            <h2 className="font-semibold text-metal-800 mb-3">1. Composition Deviation Analysis</h2>
            {steps.anomalyDetection ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant={severityVariant[steps.anomalyDetection.severity] || "default"}>
                    {steps.anomalyDetection.severity}
                  </Badge>
                  <span className="text-sm text-metal-500">
                    score {steps.anomalyDetection.anomaly_score?.toFixed(3)}
                  </span>
                </div>
                <p className="text-sm text-metal-700">{steps.anomalyDetection.explanation}</p>
              </div>
            ) : (
              <p className="text-sm text-red-600 flex items-center gap-2">
                <AlertTriangle size={16} /> {steps.anomalyAlloyError || "Composition deviation analysis unavailable — is the AI service running?"}
              </p>
            )}
          </Card>

          {/* Step 2: Alloy Recommendation */}
          <Card>
            <h2 className="font-semibold text-metal-800 mb-3">2. Melt Correction Planner</h2>
            {steps.alloyRecommendation ? (
              <div className="space-y-3">
                <div className="grid sm:grid-cols-3 gap-2">
                  {Object.entries(steps.alloyRecommendation.recommended_additions || {}).map(([el, v]) => (
                    <div key={el} className="flex justify-between text-sm bg-metal-50 rounded px-3 py-1.5">
                      <span className="font-mono font-bold">{el}</span>
                      <span className={v > 0 ? "text-green-600" : "text-metal-500"}>{v > 0 ? "+" : ""}{v}%</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-4 text-sm text-metal-600">
                  <span>Cost: ₹{steps.alloyRecommendation.estimatedCost?.totalBatchCost?.toLocaleString("en-IN")}</span>
                  <span>Carbon: {steps.alloyRecommendation.estimatedCarbon?.totalBatchCo2Kg} kg CO2e</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-red-600 flex items-center gap-2">
                <AlertTriangle size={16} /> {steps.anomalyAlloyError || "Melt correction planner unavailable"}
              </p>
            )}
          </Card>

          {/* Step 3: Closed-Loop RL Optimization */}
          <Card>
            <h2 className="font-semibold text-metal-800 mb-3">3. Adaptive Strategy Optimizer</h2>
            {steps.rlOptimization?.candidates ? (() => {
              const additionCosts = steps.rlOptimization.candidates.map((c) => c.estimatedCost.totalAdditionsCost);
              const minAdd = Math.min(...additionCosts);
              const baseCost = steps.rlOptimization.candidates[0].estimatedCost.baseMetalCost;
              return (
                <>
                  <p className="text-xs text-metal-500 mb-3">
                    Base metal cost (same for all): <strong>₹{baseCost.toLocaleString("en-IN")}</strong> — the correction cost below is what actually differs between strategies.
                  </p>
                  <div className="grid gap-4 md:grid-cols-3 pt-3">
                    {steps.rlOptimization.candidates.map((c) => {
                      const addCost = c.estimatedCost.totalAdditionsCost;
                      const deltaVsMin = minAdd > 0 ? ((addCost - minAdd) / minAdd) * 100 : 0;
                      const isChosen = chosenStrategy === c.strategy;
                      const isFrozen = !!chosenStrategy && !isChosen;
                      return (
                        <div key={c.strategy} className={`relative border-2 rounded-lg p-3 transition-all duration-300 ${isChosen ? "border-primary-500 ring-4 ring-primary-100 shadow-metal-lg" : isFrozen ? "border-metal-200 opacity-45 grayscale pointer-events-none select-none" : "border-metal-200"}`} aria-disabled={isFrozen}>
                          {isChosen && (
                            <span className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-primary-600 px-2.5 py-0.5 text-[11px] font-bold text-white shadow"><CheckCircle2 size={12} /> Selected</span>
                          )}
                          {isFrozen && (
                            <span className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-metal-700 px-2.5 py-0.5 text-[11px] font-bold text-white shadow"><Lock size={11} /> Locked</span>
                          )}
                          <div className="flex items-center justify-between mb-2">
                            <Badge variant={strategyColor[c.strategy] || "default"}>{c.strategy.toUpperCase()}</Badge>
                            <span className="text-xs text-metal-500">reward {c.predicted_reward.toFixed(3)}</span>
                          </div>

                          <div className="text-center bg-white border-2 border-dashed border-metal-200 rounded-lg py-3 mb-3">
                            <p className="text-xs text-metal-500 mb-0.5">Correction cost</p>
                            <p className="text-2xl font-bold text-metal-900">₹{addCost.toFixed(2)}</p>
                            {deltaVsMin > 0 ? (
                              <p className="text-xs text-red-600">+{deltaVsMin.toFixed(0)}% vs cheapest option</p>
                            ) : (
                              <p className="text-xs text-green-600">Cheapest option</p>
                            )}
                          </div>

                          <div className="bg-metal-50 rounded px-3 py-2 mb-3 text-xs space-y-1">
                            <p className="font-semibold text-metal-700 mb-1">Cost breakdown</p>
                            <div className="flex justify-between">
                              <span>Base metal</span><span>₹{c.estimatedCost.baseMetalCost.toLocaleString("en-IN")}</span>
                            </div>
                            {Object.entries(c.estimatedCost.additionsCost).map(([el, cost]) => (
                              <div key={el} className="flex justify-between text-metal-500 pl-2">
                                <span>+ {el}</span><span>₹{cost.toFixed(2)}</span>
                              </div>
                            ))}
                            <div className="flex justify-between font-semibold pt-1 border-t border-metal-200">
                              <span>= Total batch cost</span><span>₹{c.estimatedCost.totalBatchCost.toLocaleString("en-IN")}</span>
                            </div>
                            <div className="flex justify-between text-metal-500">
                              <span>Carbon</span><span>{c.estimatedCarbon.totalBatchCo2Kg} kg CO2e</span>
                            </div>
                          </div>

                          {c.lossIfDowngraded && (
                            <div className="bg-green-50 rounded px-3 py-2 mb-3 text-xs space-y-1">
                              <p className="font-semibold text-green-800 mb-1">If uncorrected</p>
                              <div className="flex justify-between text-green-700">
                                <span>Loss if downgraded</span><span>₹{c.lossIfDowngraded.lossPerTon.toLocaleString("en-IN")}</span>
                              </div>
                              <div className="flex justify-between font-semibold text-green-800">
                                <span>Savings by fixing</span><span>₹{c.savingsPerTon?.toLocaleString("en-IN")} ({c.savingsPercentOfSellingPrice}%)</span>
                              </div>
                            </div>
                          )}

                          {/* Mechanical Properties (per candidate) */}
                          {reading?.composition && (() => {
                            const comp = reading.composition;
                            const adds = c.recommended_additions || {};
                            const g = reading.metalGrade?.toUpperCase() || '';
                            const m = faPredictMech(g, (comp.C||0)+(adds.C||0), (comp.Si||0)+(adds.Si||0), (comp.Mn||0)+(adds.Mn||0), comp.P||0, comp.S||0);
                            return (
                              <div className={`rounded px-2 py-1.5 mb-2 text-[10px] border ${m.pass ? 'bg-violet-50 border-violet-200' : 'bg-red-50 border-red-200'}`}>
                                <div className="flex justify-between items-center mb-1">
                                  <span className="font-semibold text-metal-600 flex items-center gap-1"><Gauge size={10} /> Mech Props</span>
                                  <span className={`font-bold px-1.5 py-0.5 rounded ${m.pass ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{m.pass ? 'PASS' : 'FAIL'}</span>
                                </div>
                                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-metal-600">
                                  <span>UTS: <b className="text-metal-800">{m.uts} MPa</b></span>
                                  <span>YS: <b className="text-metal-800">{m.ys} MPa</b></span>
                                  <span>Elong: <b className="text-metal-800">{m.elong}%</b></span>
                                  <span>HB: <b className="text-metal-800">{m.hb}</b></span>
                                </div>
                                <div className="text-metal-400 mt-0.5">CE = {m.ce}</div>
                              </div>
                            );
                          })()}

                          {isUnlocked && import.meta.env.VITE_MOCK_MODE !== 'true' && !isChosen && (
                            <Button
                              type="button"
                              size="sm"
                              variant="primary"
                              className="w-full mb-1 text-[11px] py-1"
                              disabled={!!submitting || approvedStrategies[c.strategy]}
                              onClick={() => handleApproveStrategy(c)}
                            >
                              {approvedStrategies[c.strategy] ? "✓ Approved" : "Approve Correction"}
                            </Button>
                          )}
                          {isChosen ? (
                            <div className="flex items-center justify-center gap-1.5 rounded-lg bg-primary-50 border border-primary-200 py-2 text-xs font-bold text-primary-700">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Strategy accepted
                            </div>
                          ) : (
                            <div className="flex gap-1">
                              <Button type="button" size="sm" variant="success" className="flex-1" disabled={!!chosenStrategy || !!submitting} onClick={() => handleFeedback(c, "accepted")}>
                                <ThumbsUp className="w-3 h-3" />
                              </Button>
                              <Button type="button" size="sm" variant="danger" className="flex-1" disabled={!!chosenStrategy || !!submitting} onClick={() => handleFeedback(c, "rejected")}>
                                <ThumbsDown className="w-3 h-3" />
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })() : (
              <p className="text-sm text-red-600 flex items-center gap-2">
                <AlertTriangle size={16} /> {steps.rlError || "Adaptive strategy optimizer unavailable — has it been bootstrapped?"}
              </p>
            )}
          </Card>

          {/* Step 4: Root Cause Hint */}
          {steps.rootCauseHint && (
            <Card className="bg-amber-50 border-amber-200">
              <h2 className="font-semibold text-amber-800 mb-1 text-sm">Root Cause Hint (from historical data)</h2>
              <p className="text-sm text-amber-700">{steps.rootCauseHint}</p>
            </Card>
          )}

          {/* Step 5: Navigate to Mechanical Properties (after strategy accepted) */}
          {flow.stockStatus === 'deducted' && (
            <div
              onClick={() => navigate('/mechanical-properties')}
              className="bg-gradient-to-r from-violet-600 to-indigo-600 rounded-xl p-5 cursor-pointer hover:shadow-xl hover:shadow-violet-500/20 transition-all group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">💪</span>
                  <div>
                    <div className="font-bold text-white flex items-center gap-2">
                      Next: Mechanical Property Prediction
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-white/20 text-white">NEW</span>
                    </div>
                    <div className="text-xs text-violet-200 mt-1">
                      Check if this chemistry will pass UTS, YS, elongation & hardness before tapping
                    </div>
                  </div>
                </div>
                <span className="text-2xl text-white/60 group-hover:text-white group-hover:translate-x-1 transition-all">→</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
