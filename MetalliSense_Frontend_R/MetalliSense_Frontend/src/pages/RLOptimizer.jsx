import React, { useState, useEffect, useMemo, useRef } from "react";
import Card from "../components/common/Card";
import Badge from "../components/common/Badge";
import Button from "../components/common/Button";
import SyntheticGenerator from "../components/common/SyntheticGenerator";
import { rlOptimize, rlSubmitFeedback, rlPolicyStatus } from "../services/rlService";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Repeat, ThumbsUp, ThumbsDown, TrendingUp, CheckCircle2, ShieldCheck, Gauge, Play, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import GateBanner from "../components/premelt/GateBanner";
import { useMeltFlow } from "../context/MeltFlowContext";
import { deductAdditives } from "../services/premeltService";
import { errMsg } from "../components/premelt/premeltUi";
import StrategyComparison, { buildComparison } from "../components/rl/StrategyComparison";
import toast from "react-hot-toast";
import { formatPercentage } from "../utils/formatters";
import { MeltSpinner } from "../components/common/FurnaceLoader";

// ── Mechanical property standards ──────────────────────────────────────
const MECH_STANDARDS = {
  "LOW-CARBON-STEEL":    { uts_min: 370, ys_min: 230, elong_min: 20, hb_max: 200, ce_max: 0.42, sp_max: 0.080, ref: "IS 2062" },
  "MEDIUM-CARBON-STEEL": { uts_min: 550, ys_min: 300, elong_min: 10, hb_max: 320, ce_max: 0.65, sp_max: 0.080, ref: "IS 1570" },
  "HIGH-CARBON-STEEL":   { uts_min: 650, ys_min: 350, elong_min: 5,  hb_max: 380, ce_max: null, sp_max: 0.070, ref: "IS 1570" },
  "GREY-IRON":           { uts_min: 200, ys_min: null, elong_min: null, hb_max: 280, ce_max: null, sp_max: null, ref: "IS 210" },
  "SG-IRON":             { uts_min: 400, ys_min: 250, elong_min: 10, hb_max: 280, ce_max: null, sp_max: 0.085, ref: "IS 1865" },
};

function predictMech(grade, C, Si, Mn, P, S) {
  const g = (grade || "").toUpperCase();
  const isSteel = g.includes("STEEL");
  const isGrey = g === "GREY-IRON";
  let uts, ys, elong, hb, ce;

  if (isSteel) {
    ce = C + Mn / 6;
    uts = 294 + 838 * C - 452 * C * C + 276 * Mn + 80 * Si + 950 * P;
    if (g === "HIGH-CARBON-STEEL" && C > 0.8) uts *= 0.85 + 0.15 * Math.exp(-(C - 0.8) * 3);
    uts = Math.max(uts, 280);
    ys = 160 + 40 * Mn + 80 * Si + 1000 * P + 500 * C * (1 - 0.5 * C);
    if (ys >= uts * 0.92) ys = uts * 0.62;
    ys = Math.min(ys, uts * 0.9);
    elong = 45 - 35 * C - 12 * C * C - 5 * ce - 120 * S;
    if (g === "HIGH-CARBON-STEEL" && C > 0.6) elong = Math.max(elong, 12 - 5 * (C - 0.6));
    elong = Math.max(2, Math.min(45, elong));
    hb = uts / 3.45;
  } else if (isGrey) {
    ce = C + Si / 3 + P / 3;
    uts = Math.max(100, Math.min(400, 880 - 125 * ce + 35 * Mn));
    ys = uts * 0.72; elong = 0.5;
    hb = Math.max(130, Math.min(300, 100 + 35 * (4.5 - ce) + 20 * Mn));
  } else {
    ce = C + Si / 3 + P / 3;
    let pf = Math.max(0, Math.min(1, 0.15 + 0.45 * Mn - 0.15 * Si));
    uts = (370 + 40 * Si) * (1 - pf) + (650 + 50 * Mn) * pf;
    if (P > 0.05) uts -= 500 * (P - 0.05);
    if (S > 0.02) uts -= 800 * (S - 0.02);
    uts = Math.max(300, Math.min(800, uts));
    ys = uts * (0.65 - 0.1 * pf);
    elong = Math.max(1, Math.min(25, 22 - 18 * pf + 1.5 * Si - 200 * Math.max(P - 0.03, 0)));
    hb = Math.max(130, Math.min(320, 130 + 120 * pf + 15 * Si));
  }

  const std = MECH_STANDARDS[g] || {};
  let pass = true;
  const issues = [];
  if (std.uts_min && uts < std.uts_min) { pass = false; issues.push(`UTS < ${std.uts_min}`); }
  if (std.ys_min && ys < std.ys_min) { pass = false; issues.push(`YS < ${std.ys_min}`); }
  if (std.elong_min && elong < std.elong_min) { pass = false; issues.push(`Elong < ${std.elong_min}%`); }
  if (std.hb_max && hb > std.hb_max) { issues.push(`HB > ${std.hb_max}`); }
  if (std.ce_max && ce > std.ce_max) { pass = false; issues.push(`CE > ${std.ce_max}`); }
  if (std.sp_max && (P + S) > std.sp_max) { pass = false; issues.push(`S+P > ${std.sp_max}`); }

  return { uts: Math.round(uts), ys: Math.round(ys), elong: +elong.toFixed(1), hb: Math.round(hb), ce: +ce.toFixed(3), pass, issues, ref: std.ref || "" };
}

// Mini gauge for strategy cards
function MiniGauge({ label, value, unit, min, max, limitMin, limitMax }) {
  const range = max - min;
  const pct = Math.max(0, Math.min(100, ((value - min) / range) * 100));
  const fail = (limitMin != null && value < limitMin) || (limitMax != null && value > limitMax);
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-10 text-right text-metal-500 font-medium">{label}</span>
      <div className="flex-1 relative h-1.5 rounded-full bg-metal-100">
        <div className={`absolute inset-y-0 left-0 rounded-full ${fail ? 'bg-red-400' : 'bg-emerald-400'}`} style={{ width: `${pct}%` }} />
        {limitMin != null && <div className="absolute top-[-2px] bottom-[-2px] w-[1.5px] bg-blue-500" style={{ left: `${((limitMin - min) / range) * 100}%` }} />}
        {limitMax != null && <div className="absolute top-[-2px] bottom-[-2px] w-[1.5px] bg-red-500" style={{ left: `${((limitMax - min) / range) * 100}%` }} />}
      </div>
      <span className={`w-16 text-right tabular-nums font-semibold ${fail ? 'text-red-600' : 'text-metal-700'}`}>{value} {unit}</span>
    </div>
  );
}

const SPEC = {
  'SG-IRON': { C:[3.0,4.0], Si:[1.8,2.8], Mn:[0.3,1.0], P:[null,0.08], S:[null,0.03] },
  'GREY-IRON': { C:[2.5,3.8], Si:[1.0,2.5], Mn:[0.4,1.2], P:[null,0.15], S:[null,0.12] },
  'LOW-CARBON-STEEL': { C:[0.05,0.25], Si:[0.1,0.5], Mn:[0.3,0.9], P:[null,0.04], S:[null,0.05] },
  'MEDIUM-CARBON-STEEL': { C:[0.3,0.6], Si:[0.15,0.6], Mn:[0.5,1.5], P:[null,0.04], S:[null,0.05] },
  'HIGH-CARBON-STEEL': { C:[0.6,1.4], Si:[0.2,0.8], Mn:[0.6,1.8], P:[null,0.04], S:[null,0.05] },
};

const strategyColor = {
  conservative: "info",
  balanced: "success",
  aggressive: "warning",
};

const RLOptimizer = () => {
  const navigate = useNavigate();
  const { flow, isUnlocked, canRunRL, rlDone, acceptStrategy, rejectAll } = useMeltFlow();
  // Restore the last RL run for this heat when navigating back to the page
  const [reading, setReading] = useState(() => (isUnlocked ? flow.rlResult?._reading || null : null));
  const [result, setResult] = useState(() => (isUnlocked ? flow.rlResult : null));
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(null); // strategy name being submitted
  const [policyStatus, setPolicyStatus] = useState(null);
  const deductionKeysRef = useRef({});

  const getDeductionKey = (strategyName) => {
    if (!deductionKeysRef.current[strategyName]) {
      deductionKeysRef.current[strategyName] = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `deduct-${flow.heatId || 'heat'}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }
    return deductionKeysRef.current[strategyName];
  };

  useEffect(() => {
    loadPolicyStatus();
  }, []);

  const loadPolicyStatus = async () => {
    try {
      const res = await rlPolicyStatus();
      setPolicyStatus(res.data.data);
    } catch (err) {
      console.error("Failed to load RL policy status:", err);
    }
  };

  // Composition handed over by the Pre-Melt Gate (via Anomaly → Alloy).
  const buildGateReading = () => {
    const alloyReading = flow.alloyResult?._reading;
    const anomalyReading = flow.anomalyResult?._reading;
    const base = alloyReading || anomalyReading || (flow.predictedComposition ? {
      metalGrade: flow.grade,
      composition: flow.predictedComposition,
      sigma: flow.compositionSigma || {},
      deviationElements: flow.deviationElements || [],
      temperature: 1480,
      pressure: 1,
      source: `gate_prediction_${flow.gateId}`,
    } : null);
    if (!base) return null;
    return {
      ...base,
      metalGrade: base.metalGrade || flow.grade,
      batchWeightKg: flow.metalKg || flow.chargeKg || flow.targetKg || 1000,
      heatId: flow.heatId,
      fromGate: true,
    };
  };

  useEffect(() => {
    if (isUnlocked && canRunRL && !flow.rlResult && !result && !loading) {
      const gateReading = buildGateReading();
      if (gateReading) handleGenerate(gateReading);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRunRL, isUnlocked]);

  const handleGenerate = async (r) => {
    setReading(r);
    setResult(null);
    setLoading(true);
    try {
      const res = await rlOptimize(r.metalGrade, r.composition, 3, r.batchWeightKg);
      const rlData = { ...res.data.data, _reading: r };
      setResult(rlData);
      if (isUnlocked) rlDone(rlData);
      toast.success("Adaptive strategies generated");
    } catch (err) {
      console.error("RL optimize failed:", err);
      toast.error(
        err.response?.data?.message ||
          "Adaptive strategy engine unavailable — has it been bootstrapped with train_rl.py?"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleFeedback = async (candidate, outcome) => {
    if (!reading || submitting) {
      if (!reading) toast.error("No active reading — generate a synthetic reading first");
      return;
    }
    setSubmitting(candidate.strategy);
    try {
      if (import.meta.env.VITE_MOCK_MODE === 'true' && outcome === 'accepted' && isUnlocked && flow.heatId) {
        const r = await fetch('/__mock/accept-strategy', {method:'POST',body:JSON.stringify({heatId:flow.heatId,candidate,composition:reading.composition})});
        const j = await r.json();
        if (!r.ok) throw new Error(j.message);
        acceptStrategy(j.data);
        toast.success('Strategy accepted — selected quantities deducted. Policy updated.');
        await loadPolicyStatus();
        return;
      }
      await rlSubmitFeedback({
        grade: reading.metalGrade,
        composition: reading.composition,
        additions: candidate.recommended_additions,
        aggressiveness: candidate.aggressiveness,
        outcome,
        operatorNote: `Operator ${outcome} the "${candidate.strategy}" strategy from the UI`,
      });

      if (outcome === "accepted") {
        if (isUnlocked && flow.heatId) {
          // Deduct additive lots from inventory when operator accepts a strategy.
          // The gate already computed which lot and how many kg for each element.
          const idempotencyKey = getDeductionKey(candidate.strategy);
          try {
            // Build deduction lines from the gate's suggested additions (which have lotId + kg)
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
              await deductAdditives(lines, { idempotencyKey });
            }
            acceptStrategy({ ...candidate, deductedLines: lines });
            toast.success(`✅ Strategy "${candidate.strategy}" accepted — stock deducted. Policy updated.`);
          } catch (deductErr) {
            console.error("Deduction error:", deductErr);
            toast.error(`Stock deduction failed: ${errMsg(deductErr)}`);
            setSubmitting(null);
            return;
          }
        } else {
          toast.success(`Feedback recorded — policy updated (accepted)`);
        }
      } else {
        toast.success(`Feedback recorded — policy updated (rejected)`);
        // If all candidates are rejected and in gate flow, prompt to re-plan
        if (isUnlocked) rejectAll();
      }
      await loadPolicyStatus();
    } catch (err) {
      console.error("RL feedback failed:", err);
      toast.error(err.response?.data?.message || err.message || "Failed to record feedback");
    } finally {
      setSubmitting(null);
    }
  };

  const gradeKey = (reading?.metalGrade || flow.grade || "").toUpperCase();
  const comparison = useMemo(() => {
    if (!result?.candidates?.length || !reading?.composition) return null;
    const comp = reading.composition;
    return buildComparison(result.candidates, {
      composition: comp,
      spec: SPEC[gradeKey] || {},
      mechFor: (c) => {
        const a = c.recommended_additions || {};
        return predictMech(gradeKey, (comp.C || 0) + (a.C || 0), (comp.Si || 0) + (a.Si || 0), (comp.Mn || 0) + (a.Mn || 0), comp.P || 0, comp.S || 0);
      },
    });
  }, [result, reading, gradeKey]);
  const fromGate = !!(reading?.fromGate || String(reading?.source || "").startsWith("gate_prediction"));
  const scrollToStrategy = (st) => document.getElementById(`rl-strategy-${st}`)?.scrollIntoView({ behavior: "smooth", block: "center" });

  const trendData =
    policyStatus?.reward_trend?.map((r, i) => ({ i, reward: r })) || [];

  return (
    <div className="space-y-6">
      <GateBanner page="rl" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-metal-900 flex items-center gap-2">
            <Repeat className="w-7 h-7 text-primary-600" />
            Adaptive Strategy Optimizer
          </h1>
          <p className="text-metal-600 mt-1">
            Reinforcement-learning alloy correction strategies that improve
            from every operator decision. All recommendations require your
            approval — nothing is applied automatically.
          </p>
        </div>
        {policyStatus && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-50 text-primary-700">
            <TrendingUp className="w-4 h-4" />
            <span className="font-medium text-sm">
              {policyStatus.n_updates.toLocaleString()} policy updates
            </span>
          </div>
        )}
      </div>

      {!isUnlocked && (
        <SyntheticGenerator
          onDataGenerated={handleGenerate}
          buttonText="Generate & Get Strategies"
        />
      )}
      {isUnlocked && flow.rlResult && (
        <details className="text-xs text-metal-500 cursor-pointer">
          <summary className="hover:text-metal-700 font-semibold">Chemist override — run strategies on a different composition</summary>
          <div className="mt-2">
            <SyntheticGenerator onDataGenerated={handleGenerate} buttonText="Override with manual entry" />
          </div>
        </details>
      )}
      {isUnlocked && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <div className="flex flex-wrap gap-4 items-center">
            <span><strong>Heat {flow.heatId}</strong> · {flow.grade} · {flow.metalKg ? `~${Math.round(flow.metalKg)} kg metal` : ''}</span>
            {flow.anomalyResult && (
              <span>Anomaly: <strong className={flow.anomalyResult.severity === 'NORMAL' ? 'text-emerald-700' : 'text-amber-700'}>{flow.anomalyResult.severity || 'NORMAL'}</strong></span>
            )}
            {flow.alloyResult?.aiAnalysis && (
              <span>Alloy confidence: <strong className="text-emerald-700">{((flow.alloyResult.aiAnalysis.confidence || 0) * 100).toFixed(0)}%</strong></span>
            )}
            {flow.deviationElements?.length > 0 && (
              <span>Deviated: <strong className="text-amber-700">{flow.deviationElements.join(', ')}</strong></span>
            )}
          </div>
        </div>
      )}
      {isUnlocked && !result && !loading && (
        <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 flex flex-wrap items-center gap-3">
          <ShieldCheck size={16} />
          <span className="flex-1">Ready to score correction strategies on the Pre-Melt Gate composition for Heat <strong>{flow.heatId}</strong>.</span>
          <Button size="sm" onClick={() => { const g = buildGateReading(); if (g) handleGenerate(g); else toast.error("No gate composition available"); }}>
            <Play size={14} className="mr-1" /> Run strategies on gate composition
          </Button>
        </div>
      )}
      {isUnlocked && result && fromGate && (
        <div className="flex justify-end -mt-2">
          <button type="button" onClick={() => { const g = buildGateReading(); if (g) handleGenerate(g); }} className="inline-flex items-center gap-1.5 text-xs font-semibold text-metal-600 hover:text-primary-700">
            <RefreshCw size={12} /> Re-score strategies
          </button>
        </div>
      )}

      {loading && (
        <div className="rounded-2xl border border-metal-200 bg-white p-6 shadow-metal">
          <MeltSpinner label="Pouring strategies through the learned policy…" sublabel="Scoring conservative · balanced · aggressive corrections" />
          <div className="grid md:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-xl border border-metal-100 p-4 space-y-3 animate-pulse">
                <div className="h-4 w-24 rounded bg-metal-200" />
                <div className="h-8 w-20 rounded bg-metal-100" />
                <div className="h-2 w-full rounded bg-metal-100" />
                <div className="h-2 w-3/4 rounded bg-metal-100" />
              </div>
            ))}
          </div>
        </div>
      )}

      {result && result.candidates.length > 0 && (() => {
        const additionCosts = result.candidates.map((c) => c.estimatedCost.totalAdditionsCost);
        const minAdd = Math.min(...additionCosts);
        const maxAdd = Math.max(...additionCosts);
        const baseCost = result.candidates[0].estimatedCost.baseMetalCost;
        return (
          <>
            {/* Learning progress chart */}
            {trendData.length > 3 && (
              <Card title="Policy Learning Progress (recent reward trend)">
                <div style={{ width: "100%", height: 180 }}>
                  <ResponsiveContainer>
                    <LineChart data={trendData}>
                      <XAxis dataKey="i" hide />
                      <YAxis domain={["auto", "auto"]} width={40} />
                      <Tooltip formatter={(v) => v.toFixed(3)} />
                      <Line
                        type="monotone"
                        dataKey="reward"
                        stroke="#059669"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-xs text-metal-500 mt-2">
                  Avg reward (last 100 updates):{" "}
                  {policyStatus.avg_reward_last_100?.toFixed(4) ?? "n/a"} · Known
                  grades: {policyStatus.known_grades?.join(", ")}
                </p>
              </Card>
            )}
            <Card className="bg-metal-50">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-metal-600">
                  Base metal cost (same for all strategies): <strong>₹{baseCost.toLocaleString("en-IN")}</strong>
                </span>
                <span className="text-metal-600">
                  Correction cost range: <strong>₹{minAdd.toFixed(2)} – ₹{maxAdd.toFixed(2)}</strong>{" "}
                  ({maxAdd > 0 ? (((maxAdd - minAdd) / minAdd) * 100).toFixed(0) : 0}% spread — this is what actually differs between strategies)
                </span>
              </div>
            </Card>

            <div className="grid gap-4 md:grid-cols-3">
              {result.candidates.map((c) => {
                const addCost = c.estimatedCost.totalAdditionsCost;
                const deltaVsMin = minAdd > 0 ? ((addCost - minAdd) / minAdd) * 100 : 0;
                return (
                  <div id={`rl-strategy-${c.strategy}`} key={c.strategy} className="scroll-mt-24">
                  <Card className={`border-2 ${comparison?.winners.composite === c.strategy ? "border-primary-400 shadow-metal-lg" : "border-metal-200"}`}>
                    <div className="flex items-center justify-between mb-3">
                      <Badge variant={strategyColor[c.strategy] || "default"}>
                        {c.strategy.toUpperCase()}
                      </Badge>
                      <span className="text-xs text-metal-500">
                        reward {c.predicted_reward.toFixed(3)}
                      </span>
                    </div>

                    <div className="space-y-1 mb-4">
                      {Object.entries(c.recommended_additions).length === 0 && (
                        <p className="text-sm text-metal-500">No additions needed</p>
                      )}
                      {Object.entries(c.recommended_additions).map(([el, v]) => (
                        <div key={el} className="flex justify-between text-sm">
                          <span className="font-mono font-bold">{el}</span>
                          <span className={v > 0 ? "text-green-600" : "text-red-600"}>
                            {v > 0 ? "+" : ""}
                            {formatPercentage(v)}
                          </span>
                        </div>
                      ))}
                    </div>

                    

                    {/* ── Before / After composition comparison ── */}
                    {reading?.composition && Object.keys(c.recommended_additions || {}).length > 0 && (() => {
                      const grade = reading.metalGrade?.toUpperCase() || (isUnlocked ? flow.grade?.toUpperCase() : '');
                      const spec = SPEC[grade] || {};
                      const adds = c.recommended_additions || {};
                      const rows = Object.entries(adds).filter(([,v]) => v !== 0);
                      return (
                        <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
                          <p className="text-xs font-semibold text-slate-600 mb-2">Composition change (this strategy)</p>
                          <div className="space-y-1.5">
                            {rows.map(([el, delta]) => {
                              const before = reading.composition[el] ?? 0;
                              const after = before + delta;
                              const [lo, hi] = spec[el] || [null, null];
                              const wasOk = (lo === null || before >= lo) && (hi === null || before <= hi);
                              const nowOk = (lo === null || after >= lo) && (hi === null || after <= hi);
                              const improvement = !wasOk && nowOk;
                              return (
                                <div key={el} className="grid grid-cols-[2rem_1fr_auto] gap-2 items-center text-xs">
                                  <span className="font-mono font-bold text-slate-800">{el}</span>
                                  <div className="flex items-center gap-1.5">
                                    <span className="tabular-nums text-slate-500">{before.toFixed(3)}%</span>
                                    <span className="text-slate-400">→</span>
                                    <span className={`tabular-nums font-bold ${nowOk ? 'text-emerald-700' : 'text-red-600'}`}>{after.toFixed(3)}%</span>
                                    {delta > 0 && <span className="text-emerald-600 font-semibold">+{delta.toFixed(3)}</span>}
                                  </div>
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${improvement ? 'bg-emerald-100 text-emerald-800' : nowOk ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}`}>
                                    {improvement ? '✓ Fixed' : nowOk ? 'In spec' : 'Out'}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Correction cost — the part that actually differs between strategies, shown large */}
                    <div className="text-center bg-white border-2 border-dashed border-metal-200 rounded-lg py-3 mb-3">
                      <p className="text-xs text-metal-500 mb-0.5">Correction cost (this strategy)</p>
                      <p className="text-2xl font-bold text-metal-900">₹{addCost.toFixed(2)}</p>
                      {deltaVsMin > 0 && (
                        <p className="text-xs text-red-600">+{deltaVsMin.toFixed(0)}% vs cheapest option</p>
                      )}
                      {deltaVsMin === 0 && <p className="text-xs text-green-600">Cheapest option</p>}
                    </div>

                    {/* Full cost estimation process, step by step */}
                    <div className="bg-metal-50 rounded-lg px-3 py-2 mb-3 text-xs space-y-1">
                      <p className="font-semibold text-metal-700 mb-1">Cost estimation:</p>
                      <div className="flex justify-between text-metal-600">
                        <span>Base metal cost</span>
                        <span>₹{c.estimatedCost.baseMetalCost.toLocaleString("en-IN")}</span>
                      </div>
                      {Object.entries(c.estimatedCost.additionsCost).map(([el, cost]) => (
                        <div key={el} className="flex justify-between text-metal-500 pl-2">
                          <span>+ {el} correction</span>
                          <span>₹{cost.toFixed(2)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between font-semibold text-metal-800 pt-1 border-t border-metal-200">
                        <span>= Total batch cost</span>
                        <span>₹{c.estimatedCost.totalBatchCost.toLocaleString("en-IN")}</span>
                      </div>
                      <div className="flex justify-between text-metal-500">
                        <span>Carbon footprint</span>
                        <span>{c.estimatedCarbon.totalBatchCo2Kg} kg CO2e</span>
                      </div>
                    </div>

                    {/* Savings vs letting the batch downgrade */}
                    {c.lossIfDowngraded && (
                      <div className="bg-green-50 rounded-lg px-3 py-2 mb-3 text-xs space-y-1">
                        <p className="font-semibold text-green-800 mb-1">If uncorrected:</p>
                        <div className="flex justify-between text-green-700">
                          <span>Would downgrade to</span>
                          <span>{c.lossIfDowngraded.downgradeGrade}</span>
                        </div>
                        <div className="flex justify-between text-green-700">
                          <span>Loss if downgraded</span>
                          <span>₹{c.lossIfDowngraded.lossPerTon.toLocaleString("en-IN")}/ton</span>
                        </div>
                        <div className="flex justify-between font-semibold text-green-800 pt-1 border-t border-green-200">
                          <span>Savings by correcting</span>
                          <span>₹{c.savingsPerTon?.toLocaleString("en-IN")}/ton ({c.savingsPercentOfSellingPrice}%)</span>
                        </div>
                      </div>
                    )}

                    {/* ── Mechanical Property Prediction (per strategy) ── */}
                    {reading?.composition && (() => {
                      const comp = reading.composition;
                      const adds = c.recommended_additions || {};
                      const corrC = (comp.C || 0) + (adds.C || 0);
                      const corrSi = (comp.Si || 0) + (adds.Si || 0);
                      const corrMn = (comp.Mn || 0) + (adds.Mn || 0);
                      const corrP = comp.P || 0;
                      const corrS = comp.S || 0;
                      const grade = reading.metalGrade?.toUpperCase() || (isUnlocked ? flow.grade?.toUpperCase() : '');
                      const m = predictMech(grade, corrC, corrSi, corrMn, corrP, corrS);
                      const std = MECH_STANDARDS[grade] || {};
                      const isCast = grade.includes('IRON');
                      return (
                        <div className={`rounded-lg px-3 py-2.5 mb-3 text-xs border ${m.pass ? 'bg-violet-50 border-violet-200' : 'bg-red-50 border-red-200'}`}>
                          <div className="flex items-center justify-between mb-2">
                            <p className="font-semibold text-metal-700 flex items-center gap-1">
                              <Gauge size={12} className="text-violet-600" /> Mechanical Properties (after correction)
                            </p>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${m.pass ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                              {m.pass ? '✓ PASS' : '✗ FAIL'}
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            <MiniGauge label="UTS" value={m.uts} unit="MPa" min={isCast?100:200} max={isCast?700:1400} limitMin={std.uts_min} />
                            <MiniGauge label="YS" value={m.ys} unit="MPa" min={isCast?50:100} max={isCast?500:800} limitMin={std.ys_min} />
                            <MiniGauge label="Elong" value={m.elong} unit="%" min={0} max={isCast?30:50} limitMin={std.elong_min} />
                            <MiniGauge label="HB" value={m.hb} unit="" min={80} max={isCast?350:420} limitMax={std.hb_max} />
                          </div>
                          <div className="flex justify-between items-center mt-2 pt-1.5 border-t border-metal-200">
                            <span className="text-metal-500">CE = {m.ce}</span>
                            <span className="text-metal-400">{m.ref}</span>
                          </div>
                          {m.issues.length > 0 && !m.pass && (
                            <p className="text-red-600 mt-1 font-medium">{m.issues.join(' · ')}</p>
                          )}
                        </div>
                      );
                    })()}

                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="success"
                        className="flex-1"
                        disabled={!!submitting || flow.stockStatus === 'deducted'}
                        onClick={() => handleFeedback(c, "accepted")}
                      >
                        {flow.stockStatus === 'deducted' && flow.acceptedStrategy?.strategy === c.strategy
                          ? <><CheckCircle2 className="w-3 h-3 mr-1" /> Accepted</>
                          : <><ThumbsUp className="w-3 h-3 mr-1" /> {isUnlocked ? 'Accept & Deduct Stock' : 'Accept'}</>
                        }
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        className="flex-1"
                        disabled={!!submitting}
                        onClick={() => handleFeedback(c, "rejected")}
                      >
                        <ThumbsDown className="w-3 h-3 mr-1" /> Reject
                      </Button>
                    </div>
                  </Card>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* Strategy comparison grid */}
      {result && comparison && (
        <StrategyComparison
          comparison={comparison}
          heatId={fromGate ? (reading?.heatId || flow.heatId) : null}
          grade={gradeKey}
          source={fromGate ? "gate" : "manual"}
          onPick={scrollToStrategy}
        />
      )}

      {result && (
        <p className="text-xs text-center text-metal-500">
          {result.note}
        </p>
      )}
    </div>
  );
};

export default RLOptimizer;
