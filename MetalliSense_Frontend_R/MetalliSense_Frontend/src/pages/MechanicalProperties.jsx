/**
 * MechanicalProperties Page
 *
 * Predicts UTS, YS, Elongation, Hardness and PASS/FAIL from chemistry.
 *
 * Two modes:
 *  1. Gate flow: auto-runs using predictedComposition from MeltFlowContext
 *  2. Standalone: user generates a reading with SyntheticGenerator (same as other AI pages)
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Gauge, CheckCircle2, XCircle, ArrowRight,
  AlertTriangle, Info, Flame, ShieldCheck,
} from "lucide-react";
import Card from "../components/common/Card";
import Badge from "../components/common/Badge";
import Button from "../components/common/Button";
import SyntheticGenerator from "../components/common/SyntheticGenerator";
import GateBanner from "../components/premelt/GateBanner";
import { useMeltFlow } from "../context/MeltFlowContext";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { formatPercentage } from "../utils/formatters";
import { MeltSpinner } from "../components/common/FurnaceLoader";
import { completeHeat, getFinishedHeats } from "../services/salesService";
import { getHeat } from "../services/premeltService";
import { errMsg } from "../components/premelt/premeltUi";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3000";

// ── Mechanical property standards for all 5 grades ──────────────────────
const STANDARDS = {
  "LOW-CARBON-STEEL":    { uts_min: 370, ys_min: 230, elong_min: 20, hb_max: 200, ce_max: 0.42, sp_max: 0.080, ref: "IS 2062 E250" },
  "MEDIUM-CARBON-STEEL": { uts_min: 550, ys_min: 300, elong_min: 10, hb_max: 320, ce_max: 0.65, sp_max: 0.080, ref: "IS 1570 C30-C60" },
  "HIGH-CARBON-STEEL":   { uts_min: 650, ys_min: 350, elong_min: 5,  hb_max: 380, ce_max: null, sp_max: 0.070, ref: "IS 1570 C60-C100" },
  "GREY-IRON":           { uts_min: 200, ys_min: null, elong_min: null, hb_max: 280, ce_max: null, sp_max: null, ref: "IS 210 FG 200" },
  "SG-IRON":             { uts_min: 400, ys_min: 250, elong_min: 10, hb_max: 280, ce_max: null, sp_max: 0.085, ref: "IS 1865 SG 400/10" },
};

// ── Gauge bar component ─────────────────────────────────────────────────
function GaugeBar({ label, value, unit, scaleMin, scaleMax, limitMin, limitMax }) {
  if (value == null) return null;
  const range = scaleMax - scaleMin;
  const pct = Math.max(0, Math.min(100, ((value - scaleMin) / range) * 100));
  const isFail = (limitMin != null && value < limitMin) || (limitMax != null && value > limitMax);
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-metal-600 font-medium">{label}</span>
        <span className={`font-semibold tabular-nums ${isFail ? "text-red-600" : "text-metal-900"}`}>
          {typeof value === "number" ? value.toFixed(1) : value} {unit}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-metal-100">
        <div className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${isFail ? "bg-red-400" : "bg-emerald-400"}`}
          style={{ width: `${pct}%` }} />
        {limitMin != null && (
          <div className="absolute top-[-3px] bottom-[-3px] w-[2px] bg-blue-600 rounded"
            style={{ left: `${((limitMin - scaleMin) / range) * 100}%` }} title={`Min: ${limitMin}`} />
        )}
        {limitMax != null && (
          <div className="absolute top-[-3px] bottom-[-3px] w-[2px] bg-red-600 rounded"
            style={{ left: `${((limitMax - scaleMin) / range) * 100}%` }} title={`Max: ${limitMax}`} />
        )}
      </div>
      <div className="flex justify-between text-[9px] text-metal-400 mt-0.5 tabular-nums">
        <span>{scaleMin}</span>
        {limitMin != null && <span className="text-blue-500">min {limitMin}</span>}
        {limitMax != null && <span className="text-red-500">max {limitMax}</span>}
        <span>{scaleMax}</span>
      </div>
    </div>
  );
}

// ── Client-side formula prediction (same as mech_predict.py) ────────────
function predictFromChemistry(grade, C, Si, Mn, P, S) {
  const isSteel = grade.includes("STEEL");
  const isGrey = grade === "GREY-IRON";
  let uts, ys, elong, hb, ce, contributions = null;

  if (isSteel) {
    ce = C + Mn / 6;
    uts = 294 + 838 * C - 452 * C * C + 276 * Mn + 80 * Si + 950 * P;
    if (grade === "HIGH-CARBON-STEEL" && C > 0.8) uts *= 0.85 + 0.15 * Math.exp(-(C - 0.8) * 3);
    uts = Math.max(uts, 280);
    ys = 160 + 40 * Mn + 80 * Si + 1000 * P + 500 * C * (1 - 0.5 * C);
    if (ys >= uts * 0.92) ys = uts * 0.62;
    ys = Math.min(ys, uts * 0.9);
    elong = 45 - 35 * C - 12 * C * C - 5 * ce - 120 * S;
    if (grade === "HIGH-CARBON-STEEL" && C > 0.6) elong = Math.max(elong, 12 - 5 * (C - 0.6));
    elong = Math.max(2, Math.min(45, elong));
    hb = uts / 3.45;
    const cC = 838 * C - 452 * C * C, mC = 276 * Mn, sC = 80 * Si, pC = 950 * P, bC = 294;
    const tot = bC + cC + mC + sC + pC;
    contributions = {
      base_ferrite: { mpa: Math.round(bC), pct: +(bC / tot * 100).toFixed(1) },
      C: { mpa: Math.round(cC), pct: +(cC / tot * 100).toFixed(1) },
      Mn: { mpa: Math.round(mC), pct: +(mC / tot * 100).toFixed(1) },
      Si: { mpa: Math.round(sC), pct: +(sC / tot * 100).toFixed(1) },
      P: { mpa: Math.round(pC), pct: +(pC / tot * 100).toFixed(1) },
    };
  } else if (isGrey) {
    ce = C + Si / 3 + P / 3;
    uts = Math.max(100, Math.min(400, 880 - 125 * ce + 35 * Mn - 300 * Math.max(S - 0.05, 0)));
    ys = uts * 0.72;
    elong = 0.5;
    hb = Math.max(130, Math.min(300, 100 + 35 * (4.5 - ce) + 20 * Mn));
    contributions = { note: "Cast iron: strength is matrix + graphite morphology controlled." };
  } else {
    // SG-IRON
    ce = C + Si / 3 + P / 3;
    let pf = Math.max(0, Math.min(1, 0.15 + 0.45 * Mn - 0.15 * Si));
    uts = (370 + 40 * Si) * (1 - pf) + (650 + 50 * Mn) * pf;
    if (P > 0.05) uts -= 500 * (P - 0.05);
    if (S > 0.02) uts -= 800 * (S - 0.02);
    uts = Math.max(300, Math.min(800, uts));
    ys = uts * (0.65 - 0.1 * pf);
    elong = Math.max(1, Math.min(25, 22 - 18 * pf + 1.5 * Si - 200 * Math.max(P - 0.03, 0)));
    hb = Math.max(130, Math.min(320, 130 + 120 * pf + 15 * Si));
    contributions = { note: `SG Iron: Pearlite ≈ ${Math.round(pf * 100)}%. Si promotes ferrite (ductile), Mn promotes pearlite (strong).` };
  }

  // Quality checks
  const std = STANDARDS[grade] || {};
  const sp = P + S;
  const alerts = [];
  let qr = "PASS";
  if (std.uts_min && uts < std.uts_min) { alerts.push({ property: "UTS", message: `UTS ${uts.toFixed(0)} MPa below minimum ${std.uts_min} MPa`, severity: "HIGH" }); qr = "FAIL"; }
  if (std.ys_min && ys < std.ys_min) { alerts.push({ property: "YS", message: `YS ${ys.toFixed(0)} MPa below minimum ${std.ys_min} MPa`, severity: "HIGH" }); qr = "FAIL"; }
  if (std.elong_min && elong < std.elong_min) { alerts.push({ property: "Elongation", message: `Elongation ${elong.toFixed(1)}% below minimum ${std.elong_min}%`, severity: "HIGH" }); qr = "FAIL"; }
  if (std.hb_max && hb > std.hb_max) { alerts.push({ property: "Hardness", message: `Hardness ${hb.toFixed(0)} HB above max ${std.hb_max} HB`, severity: "MEDIUM" }); }
  if (std.ce_max && ce > std.ce_max) { alerts.push({ property: "CE", message: `Carbon equivalent ${ce.toFixed(3)} exceeds limit ${std.ce_max}`, severity: "HIGH" }); qr = "FAIL"; }
  if (std.sp_max && sp > std.sp_max) { alerts.push({ property: "S+P", message: `S+P = ${sp.toFixed(4)} exceeds limit ${std.sp_max}`, severity: "HIGH" }); qr = "FAIL"; }
  if (isSteel && ce > 0.40) { alerts.push({ property: "Weldability", message: `CE ${ce.toFixed(3)} above 0.40 — weldability reduced`, severity: "MEDIUM" }); }
  if (grade === "SG-IRON" && S > 0.025) { alerts.push({ property: "Nodularity", message: `S = ${S} above 0.025 — nodularity risk`, severity: "MEDIUM" }); }
  if (!alerts.length) alerts.push({ property: "All", message: "All mechanical properties within expected range", severity: "NONE" });

  // CE budget
  const ceBudget = isSteel
    ? { C: { value: C, contribution: +C.toFixed(4), share_pct: Math.round(C / ce * 100) }, "Mn/6": { value: Mn, contribution: +(Mn / 6).toFixed(4), share_pct: Math.round(Mn / 6 / ce * 100) } }
    : { C: { value: C, contribution: +C.toFixed(4), share_pct: Math.round(C / ce * 100) }, "Si/3": { value: Si, contribution: +(Si / 3).toFixed(4), share_pct: Math.round(Si / 3 / ce * 100) }, "P/3": { value: P, contribution: +(P / 3).toFixed(4), share_pct: Math.round(P / 3 / ce * 100) } };

  return {
    grade, material_family: isSteel ? "steel" : "cast_iron",
    predicted_uts_mpa: Math.round(uts * 10) / 10,
    predicted_ys_mpa: Math.round(ys * 10) / 10,
    predicted_elongation_pct: Math.round(elong * 10) / 10,
    predicted_hardness_hb: Math.round(hb),
    uts_ys_ratio: ys > 0 ? Math.round(uts / ys * 1000) / 1000 : null,
    carbon_equivalent: Math.round(ce * 10000) / 10000,
    ce_budget: ceBudget,
    element_contributions: contributions,
    quality_result: qr,
    alerts,
    reference_standard: std.ref || grade,
  };
}

// ── Main component ──────────────────────────────────────────────────────
export default function MechanicalProperties() {
  const navigate = useNavigate();
  const { flow, isUnlocked, mechDone, approveTap } = useMeltFlow();

  const [reading, setReading] = useState(null);
  const [engineer, setEngineer] = useState("");
  const [approving, setApproving] = useState(false);
  const [finished, setFinished] = useState(null); // server view of the finished heat
  const [serverMissing, setServerMissing] = useState(false); // tap approved here, but not recorded on the server

  // If the tap was approved earlier (or before this feature), make sure the server has the finished heat.
  useEffect(() => {
    if (!isUnlocked || !flow.tapApproved || !flow.heatId || finished) return;
    getFinishedHeats().then((r) => {
      const h = r.data.data.find((x) => x.heatId === flow.heatId);
      if (h) { setFinished(h); setServerMissing(false); } else setServerMissing(true);
    }).catch(() => setServerMissing(true));
  }, [isUnlocked, flow.tapApproved, flow.heatId, finished]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  // Auto-load gate composition if available
  useEffect(() => {
    if (isUnlocked && flow.predictedComposition && !reading) {
      setReading({
        metalGrade: flow.grade,
        composition: flow.predictedComposition,
        source: "gate",
      });
    }
  }, [isUnlocked, flow.predictedComposition]);

  // Auto-predict when reading is set
  useEffect(() => {
    if (reading && !result) {
      runPrediction(reading);
    }
  }, [reading]);

  // Restore from flow context
  useEffect(() => {
    if (flow.mechResult && !result) {
      setResult(flow.mechResult);
    }
  }, [flow.mechResult]);

  const handleGenerate = (r) => {
    setReading(r);
    setResult(null);
  };

  const runPrediction = async (r) => {
    const grade = r.metalGrade || r.grade;
    const comp = r.composition;
    if (!grade || !comp) return;

    setLoading(true);
    try {
      // Try API first
      const res = await fetch(`${API_BASE}/api/v2/mechanical/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grade,
          composition: { C: comp.C || 0, Si: comp.Si || 0, Mn: comp.Mn || 0, P: comp.P || 0, S: comp.S || 0 },
          mode: "formula",
        }),
      });
      const json = await res.json();
      if (json.status === "success" && json.data) {
        setResult(json.data);
        if (isUnlocked) mechDone(json.data);
        setLoading(false);
        toast.success("Mechanical property prediction complete");
        return;
      }
    } catch (err) {
      console.log("AI engine not available, using client-side formula");
    }

    // Fallback: client-side formula
    const pred = predictFromChemistry(grade, comp.C || 0, comp.Si || 0, comp.Mn || 0, comp.P || 0, comp.S || 0);
    setResult(pred);
    if (isUnlocked) mechDone(pred);
    toast.success("Mechanical properties predicted (formula mode)");
    setLoading(false);
  };

  // Approve Tap = the melt is finished: the server closes the heat, counts the
  // castings, returns runners/risers to stock and makes it ready to invoice.
  const handleApproveTap = async () => {
    if (!engineer.trim()) { toast.error("Enter the engineer's name to approve the tap"); return; }
    setApproving(true);
    let activeVer = flow.version;
    try {
      const hRes = await getHeat(flow.heatId);
      if (hRes.data?.data?.version !== undefined) activeVer = hRes.data.data.version;
    } catch (_) {}
    try {
      const res = await completeHeat(flow.heatId, {
        approvedBy: engineer.trim(),
        composition: comp,
        mechanical: result,
        standard: std,
        acceptedStrategy: flow.acceptedStrategy,
        gateDecision: flow.gateDecision,
        version: activeVer,
        expectedVersion: activeVer,
      });
      setFinished(res.data.data);
      setServerMissing(false);
      approveTap();
      const t = res.data.data.tap;
      toast.success(`✅ Tap approved — ${flow.heatId} finished: ${t.castingsKg} kg castings${t.result === "DOWNGRADED" ? ` (downgraded to ${t.soldGrade})` : ""}`);
    } catch (e) {
      toast.error(errMsg(e), { id: "tap-error", duration: 7000 });
    } finally { setApproving(false); }
  };

  const r = result;
  const grade = reading?.metalGrade || reading?.grade || flow.grade;
  const std = STANDARDS[grade] || {};
  const isCastIron = grade?.includes("IRON");
  const comp = reading?.composition || flow.predictedComposition;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Gauge className="text-violet-600" size={28} />
        <div>
          <h1 className="text-2xl font-bold text-metal-900 flex items-center gap-2">
            Mechanical Properties
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200">NEW</span>
          </h1>
          <p className="text-metal-500 text-sm">
            Predicts tensile strength, yield strength, elongation & hardness from chemistry
          </p>
        </div>
      </div>

      {/* Gate banner if in flow */}
      {isUnlocked && (
        <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4">
          <div className="flex flex-wrap gap-3 items-center">
            <Flame size={18} className="text-emerald-700 shrink-0" />
            <span className="font-bold text-emerald-900">Heat {flow.heatId} is melting</span>
            <span className="text-sm text-emerald-800 opacity-70">{flow.grade}</span>
            <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded bg-emerald-600 text-white">
              Gate: {flow.gateDecision}
            </span>
          </div>
          {flow.stockStatus === "deducted" && (
            <p className="text-xs font-semibold text-emerald-800 mt-1">
              ✅ Strategy accepted: {flow.acceptedStrategy?.strategy} — stock deducted
            </p>
          )}
        </div>
      )}

      {/* Synthetic Generator (standalone mode — same as Anomaly, Alloy, RL pages) */}
      {!isUnlocked && (
        <SyntheticGenerator onDataGenerated={handleGenerate} buttonText="Generate Reading for Mechanical Check" />
      )}

      {/* If in gate flow but reading auto-loaded */}
      {isUnlocked && reading?.source === "gate" && !result && (
        <Card className="border-emerald-200 bg-emerald-50">
          <div className="flex items-center gap-2 text-sm text-emerald-900">
            <ShieldCheck size={14} />
            <span>Using gate-predicted composition for Heat <strong>{flow.heatId}</strong> ({flow.grade})</span>
          </div>
          <Button onClick={() => runPrediction(reading)} className="mt-3" loading={loading}>
            Run Mechanical Property Check
          </Button>
        </Card>
      )}

      {/* Loading */}
      {loading && (
        <Card>
          <MeltSpinner label="Predicting mechanical properties from chemistry…" />
        </Card>
      )}

      {/* Results */}
      {r && !loading && (
        <>
          {/* Composition pills */}
          {comp && (
            <Card className="bg-metal-50 border-metal-200">
              <div className="flex flex-wrap items-center gap-2 text-xs text-metal-600 mb-2">
                <span className="font-semibold text-metal-700">Grade: {grade}</span>
                <span className="text-metal-400">·</span>
                <span>{r.material_family === "steel" ? "Steel" : "Cast Iron"}</span>
                <span className="text-metal-400">·</span>
                <span>{r.reference_standard}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(comp).filter(([, v]) => v > 0).map(([el, v]) => (
                  <span key={el} className="bg-white border border-metal-200 rounded px-2 py-0.5 text-[11px] tabular-nums">
                    <strong>{el}</strong> {typeof v === "number" ? v.toFixed(4) : v}
                  </span>
                ))}
              </div>
            </Card>
          )}

          {/* PASS / FAIL badge */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-metal-600">Quality Result</span>
            <Badge variant={r.quality_result === "PASS" ? "success" : "danger"} className="text-sm px-4 py-1">
              {r.quality_result === "PASS"
                ? <span className="flex items-center gap-1"><CheckCircle2 size={14} /> PASS</span>
                : <span className="flex items-center gap-1"><XCircle size={14} /> FAIL</span>}
            </Badge>
          </div>

          {/* Gauge bars */}
          <Card>
            <h3 className="font-semibold text-metal-800 text-sm mb-4">Predicted vs Standard Limits</h3>
            <GaugeBar label="UTS (Tensile Strength)" value={r.predicted_uts_mpa} unit="MPa"
              scaleMin={isCastIron ? 100 : 200} scaleMax={isCastIron ? 700 : 1400} limitMin={std.uts_min} />
            <GaugeBar label="Yield Strength" value={r.predicted_ys_mpa} unit="MPa"
              scaleMin={isCastIron ? 50 : 100} scaleMax={isCastIron ? 500 : 800} limitMin={std.ys_min} />
            <GaugeBar label="Elongation" value={r.predicted_elongation_pct} unit="%"
              scaleMin={0} scaleMax={isCastIron ? 30 : 50} limitMin={std.elong_min} />
            <GaugeBar label="Hardness" value={r.predicted_hardness_hb} unit="HB"
              scaleMin={80} scaleMax={isCastIron ? 350 : 420} limitMax={std.hb_max} />
            <div className="flex gap-4 text-[9px] text-metal-400 mt-2">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-600" /> Min limit</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-600" /> Max limit</span>
            </div>
          </Card>

          {/* Carbon Equivalent */}
          {r.ce_budget && (
            <Card>
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-metal-800 text-sm">
                  Carbon Equivalent {isCastIron ? "(C + Si/3 + P/3)" : "(C + Mn/6)"}
                </span>
                <span className="text-lg font-bold tabular-nums text-metal-900">
                  {r.carbon_equivalent?.toFixed(4)}
                  {std.ce_max && <span className="text-sm text-metal-500 ml-1">/ {std.ce_max}</span>}
                </span>
              </div>
              <div className="flex h-3 rounded-full overflow-hidden bg-metal-100 mb-2">
                {Object.entries(r.ce_budget).map(([el, b]) => {
                  const colors = { C: "bg-orange-400", "Mn/6": "bg-sky-400", "Si/3": "bg-sky-400", "P/3": "bg-violet-400" };
                  return <div key={el} className={colors[el] || "bg-gray-400"} style={{ width: `${b.share_pct || 0}%` }}
                    title={`${el}: ${b.contribution} (${b.share_pct}%)`} />;
                })}
              </div>
              <div className="flex gap-4 text-[10px] text-metal-500">
                {Object.entries(r.ce_budget).map(([el, b]) => {
                  const dots = { C: "bg-orange-400", "Mn/6": "bg-sky-400", "Si/3": "bg-sky-400", "P/3": "bg-violet-400" };
                  return <span key={el} className="flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-full ${dots[el] || "bg-gray-400"}`} />{el}: {b.share_pct}%
                  </span>;
                })}
              </div>
            </Card>
          )}

          {/* Element Contributions (steel only) */}
          {r.element_contributions && !r.element_contributions.note && (
            <Card>
              <h3 className="font-semibold text-metal-800 text-sm mb-3">Strength Contributions (UTS)</h3>
              {Object.entries(r.element_contributions).sort(([, a], [, b]) => b.mpa - a.mpa).map(([el, v]) => {
                const maxMpa = Math.max(...Object.values(r.element_contributions).map(x => x.mpa));
                return (
                  <div key={el} className="flex items-center gap-2 text-xs mb-1.5">
                    <span className="w-20 text-right text-metal-500">{el === "base_ferrite" ? "Base ferrite" : el}</span>
                    <div className="flex-1 h-2.5 rounded bg-metal-100 relative">
                      <div className="absolute inset-y-0 left-0 rounded bg-indigo-400"
                        style={{ width: `${maxMpa > 0 ? (v.mpa / maxMpa) * 100 : 0}%` }} />
                    </div>
                    <span className="w-28 tabular-nums text-metal-700">{v.mpa} MPa ({v.pct}%)</span>
                  </div>
                );
              })}
            </Card>
          )}

          {/* Cast iron note */}
          {r.element_contributions?.note && (
            <Card className="bg-metal-50 border-metal-200">
              <div className="flex items-start gap-2 text-sm text-metal-600">
                <Info size={16} className="mt-0.5 shrink-0 text-metal-400" />
                <span>{r.element_contributions.note}</span>
              </div>
            </Card>
          )}

          {/* Alerts */}
          <div className="space-y-2">
            {r.alerts?.map((a, i) => {
              const cls = a.severity === "HIGH" ? "border-red-200 bg-red-50 text-red-700"
                : a.severity === "MEDIUM" ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700";
              const dot = a.severity === "HIGH" ? "bg-red-500" : a.severity === "MEDIUM" ? "bg-amber-500" : "bg-emerald-500";
              return (
                <div key={i} className={`flex items-start gap-2 rounded-lg border ${cls} px-3 py-2 text-xs`}>
                  <span className={`mt-1 w-2 h-2 rounded-full ${dot} shrink-0`} />
                  <span>{a.message}</span>
                </div>
              );
            })}
          </div>

          {/* Tap Approval — only in gate flow */}
          {isUnlocked && !flow.tapApproved && (
            <Card className="border-2 border-blue-300">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">🧑‍🔧</span>
                <h3 className="font-bold text-metal-900">Engineer Decision: Approve Tap?</h3>
              </div>
              <p className="text-sm text-metal-600 mb-4">
                Mechanical properties predicted to{" "}
                <strong className={r.quality_result === "PASS" ? "text-emerald-600" : "text-red-600"}>
                  {r.quality_result}
                </strong>.{" "}
                {r.quality_result === "PASS" ? "All values within limits." : "Review alerts above."}
              </p>
              <label className="block text-xs font-semibold text-metal-700 mb-3">Engineer approving the tap
                <input value={engineer} onChange={(e) => setEngineer(e.target.value)} placeholder="Your name"
                  className="mt-1 w-full px-3 py-2 border-2 border-metal-200 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                <span className="block text-[11px] font-normal text-metal-500 mt-1">Approving finishes the heat: castings are counted, runners and risers go back to stock as returns, and the heat is ready to invoice.</span>
              </label>
              <div className="flex gap-2">
                <Button variant="success" className="flex-1" onClick={handleApproveTap} loading={approving} disabled={!engineer.trim()}>
                  <CheckCircle2 size={16} className="mr-1" /> Approve Tap
                </Button>
                <Button variant="default" onClick={() => navigate("/full-analysis")}>
                  ↩ Back to Full Analysis
                </Button>
              </div>
            </Card>
          )}

          {isUnlocked && flow.tapApproved && (
            <Card className="border-2 border-emerald-300 bg-emerald-50">
              <div className="flex items-center gap-3">
                <CheckCircle2 size={32} className="text-emerald-600 shrink-0" />
                <div>
                  <p className="font-bold text-emerald-800">Tap Approved — Heat {flow.heatId} Released</p>
                  <p className="text-xs text-emerald-700 mt-1 tabular-nums">
                    UTS={r.predicted_uts_mpa} MPa · YS={r.predicted_ys_mpa} MPa · Elong={r.predicted_elongation_pct}% · HB={r.predicted_hardness_hb}
                  </p>
                  {finished?.tap && (
                    <p className="text-xs text-emerald-800 mt-1">
                      {finished.tap.castingsKg} kg castings{finished.tap.result === "DOWNGRADED" ? ` — downgraded to ${finished.tap.soldGrade}` : ` of ${finished.gradeLabel}`} · {finished.tap.returnsKg} kg returns back to stock ({finished.tap.returnsLotId}) · approved by {finished.tap.approvedBy}
                    </p>
                  )}
                </div>
              </div>
              {serverMissing && !finished ? (
                <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
                  <p className="text-xs text-amber-900 mb-2"><b>Not recorded on the server yet.</b> This tap was approved before the server knew about it (for example the backend was restarted). Record it to create the invoice and certificate.</p>
                  <div className="flex gap-2">
                    <input value={engineer} onChange={(e) => setEngineer(e.target.value)} placeholder="Engineer name"
                      className="flex-1 px-3 py-2 border-2 border-metal-200 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                    <Button size="sm" onClick={handleApproveTap} loading={approving} disabled={!engineer.trim()}>Record finished heat</Button>
                  </div>
                </div>
              ) : (
                <Button className="w-full mt-4" disabled={!finished} onClick={() => navigate(`/sales?heat=${flow.heatId}`)}>
                  Create invoice &amp; test certificate <ArrowRight size={15} className="ml-1" />
                </Button>
              )}
            </Card>
          )}

          <p className="text-[10px] text-metal-400 leading-relaxed">
            Predicted from chemistry using published empirical relationships. Actual values depend on processing.
            Model auto-calibrates as real UTM test results are linked back to heat chemistry.
          </p>
        </>
      )}
    </div>
  );
}
