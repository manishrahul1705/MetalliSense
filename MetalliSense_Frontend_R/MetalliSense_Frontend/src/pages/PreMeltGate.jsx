import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, Lock, LockOpen, Flame, Plus, Trash2, Sparkles, ChevronDown, Microscope, RotateCcw, ArrowRight, Boxes, ScanLine, FlaskConical, BrainCircuit, Clock, Check, Zap } from "lucide-react";
import ReadAloud from "../components/common/ReadAloud";
import toast from "react-hot-toast";
import clsx from "clsx";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import {
  getHeats, getHeat, planHeat, updateCharge, runGateCheck, startMelting, getLots, getPremeltConfig, getAudit, resetDemo,
} from "../services/premeltService";
import { useMeltFlow } from "../context/MeltFlowContext";
import { StatusPill, CheckPill, ChemBar, Field, inputCls, kg, errMsg, SOURCE_LABEL, HeatStatusPill } from "../components/premelt/premeltUi";
import { MeltSpinner } from "../components/common/FurnaceLoader";

const DECISION = {
  GO: { title: "GO", text: "Charge cleared", slab: "bg-primary-600 text-white", ring: "border-primary-600", icon: LockOpen },
  WARN: { title: "WARN", text: "Start after acknowledging", slab: "bg-amber-500 text-metal-950", ring: "border-amber-500", icon: LockOpen },
  HOLD: { title: "HOLD", text: "Furnace start locked", slab: "bg-red-700 text-white", ring: "border-red-700", icon: Lock },
};
const pct = (v) => `${Math.round(v * 100)}%`;

// Spoken summary of a gate result for the ElevenLabs read-aloud button
function gateSpeech(heat, gate) {
  if (!gate) return "";
  const spell = (id) => String(id || "").split("").join(" ");
  const fails = gate.checks.filter((c) => c.status === "FAIL").map((c) => c.title);
  const warns = gate.checks.filter((c) => c.status === "WARN").map((c) => c.title);
  const risk = gate.ai?.before_correction?.risk;
  const after = gate.ai?.after_correction?.risk;
  return [
    `Pre-melt gate result for heat ${spell(heat.heatId)}, grade ${String(heat.grade).replace(/-/g, " ").toLowerCase()}.`,
    `Decision: ${gate.decision}. ${gate.headline || ""}`,
    `${gate.checks.filter((c) => c.status === "PASS").length} of ${gate.checks.length} checks passed.`,
    fails.length ? `Failed: ${fails.join(", ")}.` : "",
    warns.length ? `Warnings: ${warns.join(", ")}.` : "",
    risk != null ? `A I predicts a ${Math.round(risk * 100)} percent chance of an off-spec heat as charged${after != null ? `, and ${Math.round(after * 100)} percent after the suggested additions` : ""}.` : "",
    gate.decision === "HOLD" ? "Furnace start is locked." : "The furnace may be started once the operator signs off.",
  ].filter(Boolean).join(" ");
}

const FLOW_STEPS = [
  { label: "Raw material", icon: Boxes },
  { label: "Yard inspection", icon: ScanLine },
  { label: "DRI lab", icon: FlaskConical },
  { label: "Pre-Melt Gate", icon: ShieldCheck },
  { label: "Melting", icon: Flame },
  { label: "AI analysis", icon: BrainCircuit },
];

function FlowStepper({ active }) {
  return (
    <ol className="flex items-center gap-1 overflow-x-auto pb-1">
      {FLOW_STEPS.map((st, i) => {
        const done = i < active, cur = i === active;
        return (
          <li key={st.label} className="flex items-center gap-1 shrink-0">
            <span className={clsx("flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 transition-colors",
              cur ? "bg-white text-metal-900 ring-white shadow" : done ? "bg-primary-500/20 text-primary-200 ring-primary-400/40" : "bg-white/5 text-white/50 ring-white/10")}>
              {done ? <Check size={12} /> : <st.icon size={12} />}{st.label}
            </span>
            {i < FLOW_STEPS.length - 1 && <span className={clsx("w-4 h-px", done ? "bg-primary-400/60" : "bg-white/15")} />}
          </li>
        );
      })}
    </ol>
  );
}

function RiskDial({ value, label, sub }) {
  const r = 30, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value || 0));
  const color = v >= 0.5 ? "#b91c1c" : v >= 0.25 ? "#d97706" : "#0fa055";
  return (
    <div className="rounded-xl border border-metal-200 bg-gradient-to-b from-white to-metal-50 p-3 flex flex-col items-center text-center gap-1">
      <svg width="76" height="76" viewBox="0 0 76 76" className="shrink-0" role="img" aria-label={`${label} ${pct(v)}`}>
        <circle cx="38" cy="38" r={r} fill="none" stroke="#e5eaef" strokeWidth="8" />
        <circle cx="38" cy="38" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`} transform="rotate(-90 38 38)" style={{ transition: "stroke-dasharray 800ms ease" }} />
        <text x="38" y="43" textAnchor="middle" fontSize="16" fontWeight="800" fill={color}>{pct(v)}</text>
      </svg>
      <p className="text-xs font-semibold text-metal-700">{label}</p>
      <p className="text-[11px] text-metal-500 leading-snug">{sub}</p>
    </div>
  );
}

function CheckRow({ c }) {
  const [open, setOpen] = useState(c.status === "FAIL");
  return (
    <div className="border-b border-metal-100 last:border-0">
      <button className="w-full flex items-start gap-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="w-14 shrink-0 pt-0.5"><CheckPill status={c.status} /></span>
        <span className="flex-1">
          <span className="block font-semibold text-sm text-metal-900">{c.title}</span>
          <span className="block text-sm text-metal-600">{c.summary}</span>
        </span>
        {c.details?.length > 0 && <ChevronDown size={16} className={clsx("mt-1 text-metal-400 transition-transform", open && "rotate-180")} />}
      </button>
      {open && c.details?.length > 0 && (
        <ul className="pl-[4.25rem] pb-3 space-y-1">
          {c.details.map((d, i) => (
            <li key={i} className="flex gap-2 text-xs text-metal-700"><CheckPill status={d.status} /><span className="pt-0.5">{d.text}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Energy this charge will need, shown with the gate decision (from the Energy per Heat model).
function GateEnergy({ e, decision, heatId }) {
  const navigate = useNavigate();
  if (!e) return null;
  const onOpen = () => navigate(`/energy?heat=${heatId}`);
  const inr = (v) => `₹${Math.round(v).toLocaleString("en-IN")}`;
  const held = decision === "HOLD" && e.avoidedIfHeld;
  return (
    <div className={clsx("border-b border-metal-100 px-5 py-3 text-sm", held ? "bg-emerald-50" : "bg-white")}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-bold text-metal-900"><Zap size={15} className="text-amber-500" />Predicted energy</span>
        <span className="tabular-nums"><b>{e.kwh.toLocaleString("en-IN")} kWh</b> <span className="text-metal-500">({e.kwhPerT} kWh/t vs {e.baselineKwhPerT} base)</span></span>
        <span className="tabular-nums"><b>{inr(e.rs)}</b> <span className="text-metal-500">at {e.tariffBand} tariff ₹{e.tariffRsPerKwh}/kWh</span></span>
        <span className="tabular-nums text-metal-600">{e.co2Kg} kg CO₂</span>
        {onOpen && <button type="button" onClick={onOpen} className="ml-auto text-xs font-semibold text-primary-700 hover:underline">Energy details →</button>}
      </div>
      {held && (
        <p className="mt-1.5 text-xs font-semibold text-emerald-800">
          Holding this heat avoids melting a bad charge: {e.avoidedIfHeld.kwh.toLocaleString("en-IN")} kWh, {inr(e.avoidedIfHeld.rs)} and {e.avoidedIfHeld.co2Kg} kg CO₂ saved.
        </p>
      )}
      {e.topDrivers?.length > 0 && (
        <p className="mt-1 text-xs text-metal-600">
          Biggest effects: {e.topDrivers.map((d) => `${d.label} (${d.kwh > 0 ? "+" : ""}${Math.round(d.kwh)} kWh)`).join(" · ")}
          {e.potentialRsSaved > 0 && <span className="text-emerald-700 font-semibold"> · could save {inr(e.potentialRsSaved)}</span>}
        </p>
      )}
    </div>
  );
}

function Interlock({ heat, gate, dirty, onStarted, onGatePassed, onContinue }) {
  const [operator, setOperator] = useState("");
  const [ack, setAck] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const [engineer, setEngineer] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);
  useEffect(() => { setAck(false); setShowOverride(false); }, [gate?.gateId]);

  if (heat.status !== "PLANNED" && heat.status !== "GATE_EVALUATED") {
    const s = heat.start;
    const isTerminal = heat.status === "RELEASED" || heat.status === "REJECTED";
    const isCompleted = heat.status === "COMPLETED";
    const isHeld = heat.status === "HELD";
    return (
      <div className={clsx(
        "relative overflow-hidden rounded-2xl p-6 text-white shadow-metal-xl",
        isTerminal ? (heat.status === "RELEASED" ? "bg-gradient-to-br from-emerald-950 via-metal-900 to-teal-950" : "bg-gradient-to-br from-red-950 via-metal-900 to-zinc-950")
        : isCompleted ? "bg-gradient-to-br from-teal-950 via-metal-900 to-cyan-950"
        : isHeld ? "bg-gradient-to-br from-amber-950 via-metal-900 to-yellow-950"
        : "bg-gradient-to-br from-metal-950 via-metal-900 to-orange-950"
      )}>
        <div className="pointer-events-none absolute -right-10 -top-10 w-48 h-48 rounded-full bg-orange-500/20 blur-3xl" />
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid place-items-center w-11 h-11 rounded-xl bg-orange-500/20 ring-1 ring-orange-400/40">
            {isCompleted || heat.status === "RELEASED" ? <ShieldCheck className="text-emerald-400" /> : isHeld ? <AlertTriangle className="text-amber-400" /> : <Flame className="text-orange-400 animate-pulse" />}
          </span>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <p className="text-[11px] uppercase tracking-widest text-orange-300/80 font-semibold">Heat Workflow</p>
              <HeatStatusPill status={heat.status} />
            </div>
            <p className="text-xl font-bold">{heat.heatId} — {heat.status}</p>
          </div>
          {gate && <ReadAloud text={() => gateSpeech(heat, gate)} label="Read gate result" variant="dark" />}
        </div>
        {s && (
          <p className="text-sm text-metal-200 mt-2">
            Started {new Date(s.at).toLocaleString()} by {s.by} after gate {s.gateId} ({s.gateDecision}).
            {s.mode === "WARN_ACKNOWLEDGED" && ` ${s.acknowledgedWarnings.length} warning(s) acknowledged.`}
            {s.mode === "ENGINEER_OVERRIDE" && ` HOLD overridden by ${s.override.engineer}: “${s.override.reason}”.`}
          </p>
        )}
        {isCompleted && (
          <p className="text-sm text-teal-200 mt-2">Heat tap approved. Ready for dispatch, invoicing and mill test certification.</p>
        )}
        {isHeld && (
          <p className="text-sm text-amber-200 mt-2">Heat is on HOLD. Quality review required before proceeding.</p>
        )}
        {isTerminal && (
          <p className="text-sm text-metal-300 mt-2">Terminal state reached ({heat.status}). Heat lifecycle finalized; further mutations disabled.</p>
        )}
        {!isTerminal && !isCompleted && (
          <p className="text-sm text-metal-300 mt-2">Charge reserved. The gate's predicted melt-down chemistry now feeds Composition Deviation Analysis → Melt Correction Planner → Adaptive Strategy Optimizer.</p>
        )}
        {gate?.prediction && onContinue && !isTerminal && (
          <button type="button" onClick={() => onContinue(heat, gate)}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-white text-metal-900 px-4 py-2.5 text-sm font-bold shadow hover:bg-primary-50 transition-colors">
            <BrainCircuit size={16} className="text-primary-600" /> Continue to AI analysis <ArrowRight size={15} />
          </button>
        )}
      </div>
    );
  }
  if (!gate) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-metal-300 bg-white/70 p-6 flex items-center gap-4">
        <span className="grid place-items-center w-12 h-12 rounded-xl bg-metal-100"><Lock className="text-metal-400" size={24} /></span>
        <div><p className="font-bold text-metal-900">Furnace start is locked</p><p className="text-sm text-metal-600">Run the pre-melt check on this charge to unlock it.</p></div>
      </div>
    );
  }

  const d = DECISION[gate.decision];
  const expired = now > new Date(gate.validUntil).getTime();
  const stale = dirty || heat.gate?.stale;
  const minsLeft = Math.max(0, Math.round((new Date(gate.validUntil).getTime() - now) / 60000));
  const blockedBy = stale ? "The charge changed after this check. Run the check again." : expired ? "This check has expired. Run it again." : null;

  const start = async (override) => {
    setBusy(true);
    try {
      await startMelting(heat.heatId, {
        operator,
        acknowledgeWarnings: ack,
        override,
        expectedVersion: heat.version,
        version: heat.version,
      });
      toast.success(`${heat.heatId}: furnace started`);
      if (gate?.prediction && onGatePassed) onGatePassed(heat, gate);
      onStarted();
    } catch (e) {
      toast.error(errMsg(e));
      if (e?.response?.status === 409 && onStarted) {
        onStarted();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={clsx("rounded-2xl border-2 overflow-hidden bg-white shadow-metal-lg", d.ring)}>
      <div className={clsx("relative overflow-hidden flex flex-wrap items-center gap-4 px-6 py-5", d.slab)}>
        <div className="pointer-events-none absolute -right-8 -top-12 w-44 h-44 rounded-full bg-white/10 blur-2xl" />
        <span className="grid place-items-center w-14 h-14 rounded-2xl bg-black/10 ring-1 ring-white/25 shrink-0"><d.icon size={30} /></span>
        <div className="flex-1 min-w-[12rem]">
          <p className="text-[11px] uppercase tracking-[0.2em] font-bold opacity-75">Gate decision</p>
          <p className="text-4xl font-black tracking-wide leading-none">{d.title}</p>
          <p className="text-sm font-semibold opacity-90 mt-1">{gate.headline}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <ReadAloud text={() => gateSpeech(heat, gate)} label="Read decision" variant="dark" />
          <p className="text-[11px] opacity-80 text-right font-mono flex items-center gap-1"><Clock size={11} />{gate.gateId} · {expired ? "expired" : `valid ${minsLeft} min`}</p>
        </div>
      </div>
      <div className="grid grid-cols-4 divide-x divide-metal-100 border-b border-metal-100 bg-metal-50/60 text-center">
        {["PASS", "WARN", "FAIL", "SKIP"].map((st) => (
          <div key={st} className="py-2.5">
            <p className={clsx("text-lg font-black tabular-nums", st === "PASS" ? "text-primary-700" : st === "WARN" ? "text-amber-600" : st === "FAIL" ? "text-red-700" : "text-metal-400")}>{gate.checks.filter((c) => c.status === st).length}</p>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-metal-500">{st === "SKIP" ? "N/A" : st.toLowerCase()}</p>
          </div>
        ))}
      </div>
      <GateEnergy e={gate.energy} decision={gate.decision} heatId={heat.heatId} />
      <div className="p-5 space-y-3">
        {blockedBy && <p className="text-sm font-semibold text-red-700">{blockedBy}</p>}
        {gate.decision === "HOLD" && gate.blocking.length > 0 && (
          <ul className="text-sm text-red-800 list-disc ml-5 space-y-0.5">{gate.blocking.map((b) => <li key={b}>{b}</li>)}</ul>
        )}
        {gate.decision === "WARN" && (
          <label className="flex items-start gap-2 text-sm text-metal-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I have read these warnings and accept them for this heat:
              <ul className="list-disc ml-5 mt-1 text-metal-700">{gate.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </span>
          </label>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Furnace operator" className="w-56"><input className={inputCls} value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Name" /></Field>
          <Button size="lg" onClick={() => start(undefined)} loading={busy}
            disabled={!operator || !!blockedBy || gate.decision === "HOLD" || (gate.decision === "WARN" && !ack)}>
            {gate.decision === "HOLD" ? <><Lock size={18} className="mr-2" />Start melting — locked</> : <><Flame size={18} className="mr-2" />Start melting (reserve stock)</>}
          </Button>
          {gate.decision === "HOLD" && !blockedBy && (
            <button className="text-sm text-red-700 underline underline-offset-2" onClick={() => setShowOverride(!showOverride)}>Engineer override…</button>
          )}
        </div>
        {gate.decision !== "HOLD" && !blockedBy && (
          <p className="text-xs text-metal-500 mt-2">
            Stock is <strong>reserved</strong> now. It is permanently <strong>deducted</strong> only after you accept a strategy in the Adaptive Strategy Optimizer.
          </p>
        )}
        {showOverride && gate.decision === "HOLD" && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 p-3 space-y-2">
            <p className="text-xs text-red-900">An override is logged against your name with the blocking reasons. Use it only for a deliberate, documented decision.</p>
            <div className="grid sm:grid-cols-[14rem_1fr] gap-2">
              <input className={inputCls} placeholder="Engineer name" value={engineer} onChange={(e) => setEngineer(e.target.value)} />
              <input className={inputCls} placeholder="Reason (at least 20 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button variant="danger" size="sm" loading={busy} disabled={!operator || !engineer || reason.trim().length < 20} onClick={() => start({ engineer, reason })}>
              Override and start melting
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PreMeltGate() {
  const navigate = useNavigate();
  const { gatePassed, flow } = useMeltFlow();

  // Push a melting heat (even one started in an earlier session) into the
  // Anomaly → Alloy → RL flow, then go to the first AI step.
  const continueToAI = (h, g) => {
    if (flow.heatId !== h.heatId) gatePassed(h, g);
    navigate("/anomaly");
  };
  const [heats, setHeats] = useState([]);
  const [heatId, setHeatId] = useState("");
  const [heat, setHeat] = useState(null);
  const [lots, setLots] = useState([]);
  const [grades, setGrades] = useState([]);
  const [charge, setCharge] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [newHeat, setNewHeat] = useState({ grade: "SG-IRON", targetKg: 1000 });
  const [audit, setAudit] = useState([]);
  const [booting, setBooting] = useState(true);

  const loadHeats = useCallback(async (select) => {
    const r = await getHeats();
    setHeats(r.data.data);
    const pick = select || heatId || r.data.data.find((h) => h.status === "PLANNED")?.heatId || r.data.data[0]?.heatId;
    if (pick) setHeatId(pick);
  }, [heatId]);

  const loadHeat = useCallback(async (id) => {
    if (!id) return;
    const r = await getHeat(id);
    setHeat(r.data.data);
    setCharge(r.data.data.charge.map((l) => ({ ...l })));
    setDirty(false);
  }, []);

  const loadLots = useCallback(() => getLots().then((r) => setLots(r.data.data)), []);
  const loadAudit = useCallback(() => getAudit(12).then((r) => setAudit(r.data.data)), []);

  useEffect(() => {
    Promise.all([loadHeats(), loadLots(), loadAudit(), getPremeltConfig().then((r) => setGrades(Object.keys(r.data.data.gradeSpecs)))])
      .catch((e) => toast.error(errMsg(e, "Could not load the Pre-Melt Gate")))
      .finally(() => setBooting(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadHeat(heatId).catch((e) => toast.error(errMsg(e))); }, [heatId, loadHeat]);

  const lotById = useMemo(() => Object.fromEntries(lots.map((l) => [l.lotId, l])), [lots]);
  const chargeKg = charge.reduce((s, l) => s + (Number(l.kg) || 0), 0);
  const gate = heat?.gateResult;
  const planned = heat?.status === "PLANNED";

  const editLine = (i, patch) => { setCharge((c) => c.map((l, j) => (j === i ? { ...l, ...patch } : l))); setDirty(true); };
  const removeLine = (i) => { setCharge((c) => c.filter((_, j) => j !== i)); setDirty(true); };
  const addLine = () => { setCharge((c) => [...c, { lotId: "", kg: "" }]); setDirty(true); };

  const saveCharge = async () => {
    const lines = charge.filter((l) => l.lotId && Number(l.kg) > 0).map((l) => ({ lotId: l.lotId, kg: Number(l.kg) }));
    const r = await updateCharge(heat.heatId, { charge: lines });
    setHeat(r.data.data);
    setCharge(r.data.data.charge.map((l) => ({ ...l })));
    setDirty(false);
    return r;
  };

  const check = async () => {
    setChecking(true);
    try {
      if (dirty) await saveCharge();
      const r = await runGateCheck(heat.heatId, "Melt shop");
      toast(r.data.data.decision === "GO" ? "GO — charge cleared" : r.data.data.decision === "WARN" ? "WARN — review the warnings" : "HOLD — furnace start locked",
        { icon: r.data.data.decision === "GO" ? "✅" : r.data.data.decision === "WARN" ? "⚠️" : "⛔" });
      await loadHeat(heat.heatId);
      loadHeats(heat.heatId);
      loadAudit();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setChecking(false);
    }
  };

  const applyAdditions = () => {
    const next = charge.map((l) => ({ ...l }));
    gate.suggestedAdditions.filter((a) => a.lotId && a.kg).forEach((a) => {
      const line = next.find((l) => l.lotId === a.lotId);
      if (line) line.kg = Math.round((Number(line.kg) + a.kg) * 10) / 10;
      else next.push({ lotId: a.lotId, kg: a.kg });
    });
    setCharge(next);
    setDirty(true);
    toast.success("Additions added to the charge. Run the check again.");
  };

  const createHeat = async () => {
    try {
      const r = await planHeat({ ...newHeat, targetKg: Number(newHeat.targetKg), charge: [], plannedBy: "Melt shop" });
      await loadHeats(r.data.data.heatId);
      toast.success(`${r.data.data.heatId} planned — add the charge`);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const reset = async () => {
    if (!window.confirm("Reset all stock, heats and inspections to the starting point?")) return;
    await resetDemo();
    setHeatId("");
    await Promise.all([loadHeats("H-1051"), loadLots(), loadAudit()]);
    toast.success("Reset complete");
  };

  const selectableLots = lots.filter((l) => l.status !== "CONSUMED");
  const specRanges = gate?.spec?.ranges || {};
  const specDetail = gate?.checks.find((c) => c.id === "spec_prediction")?.details || [];
  const residualDetail = gate?.checks.find((c) => c.id === "residuals")?.details || [];
  const statusOf = (list, el) => list.find((d) => d.element === el)?.status;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-metal-950 via-metal-900 to-primary-950 text-white p-6 md:p-8 shadow-metal-xl">
        <div className="pointer-events-none absolute -top-24 -right-16 w-80 h-80 rounded-full bg-primary-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-1/3 w-72 h-72 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)", backgroundSize: "32px 32px" }} />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="grid place-items-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-400 to-primary-700 shadow-lg ring-1 ring-white/20"><ShieldCheck size={28} /></span>
            <div>
              <p className="text-[11px] uppercase tracking-[0.25em] text-primary-300 font-semibold">Furnace interlock</p>
              <h1 className="text-3xl font-black tracking-tight">Pre-Melt Gate</h1>
              <p className="text-white/60 text-sm max-w-xl mt-1">The furnace starts only when the charge passes — raw-material problems are caught before melting, not after.</p>
            </div>
          </div>
          <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white/70 ring-1 ring-white/15 hover:bg-white/10 hover:text-white">
            <RotateCcw size={13} />Reset
          </button>
        </div>
        <div className="relative grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          {[
            ["Planned heats", heats.filter((h) => h.status === "PLANNED").length, "text-white"],
            ["Melting / done", heats.filter((h) => h.status !== "PLANNED").length, "text-orange-300"],
            ["Cleared (GO)", heats.filter((h) => h.gate?.decision === "GO").length, "text-primary-300"],
            ["On HOLD", heats.filter((h) => h.gate?.decision === "HOLD" && h.status === "PLANNED").length, "text-red-300"],
          ].map(([l, v, cls]) => (
            <div key={l} className="rounded-xl bg-white/5 ring-1 ring-white/10 backdrop-blur px-4 py-3">
              <p className={clsx("text-2xl font-black tabular-nums", cls)}>{v}</p>
              <p className="text-[11px] uppercase tracking-wider text-white/50 font-semibold">{l}</p>
            </div>
          ))}
        </div>
        <div className="relative mt-5">
          <FlowStepper active={!heat ? 3 : heat.status === "PLANNED" ? 3 : flow.heatId === heat.heatId && flow.anomalyResult ? 5 : 4} />
        </div>
      </div>

      <div className="grid lg:grid-cols-[16rem_1fr] gap-6 items-start">
        <div className="space-y-4">
          <Card title="Heats">
            <div className="space-y-1 -mx-2">
              {heats.map((h) => (
                <button key={h.heatId} onClick={() => setHeatId(h.heatId)}
                  className={clsx("w-full text-left rounded-xl px-3 py-2.5 border transition-all focus:outline-none focus:ring-2 focus:ring-primary-500", h.heatId === heatId ? "bg-gradient-to-r from-primary-50 to-white border-primary-300 shadow-sm" : "border-transparent hover:bg-metal-50 hover:border-metal-200")}>
                  <span className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-mono font-bold text-sm">
                      <span className={clsx("w-2 h-2 rounded-full", h.status === "PLANNED" ? (h.gate ? (h.gate.decision === "GO" ? "bg-primary-500" : h.gate.decision === "WARN" ? "bg-amber-500" : "bg-red-600") : "bg-metal-300") : "bg-orange-500 animate-pulse")} />
                      {h.heatId}
                    </span>
                    {h.gate && h.status === "PLANNED" && <span className={clsx("text-[10px] font-black px-1.5 rounded", DECISION[h.gate.decision].slab)}>{h.gate.decision}</span>}
                  </span>
                  <span className="flex items-center justify-between text-xs text-metal-500 mt-1">
                    <span>{h.grade}</span>
                    <HeatStatusPill status={h.status} className="scale-90 origin-right" />
                  </span>
                </button>
              ))}
            </div>
          </Card>
          <Card title="Plan a heat">
            <Field label="Grade">
              <select className={inputCls} value={newHeat.grade} onChange={(e) => setNewHeat({ ...newHeat, grade: e.target.value })}>
                {grades.map((g) => <option key={g}>{g}</option>)}
              </select>
            </Field>
            <Field label="Target charge (kg)" className="mt-3"><input type="number" className={inputCls} value={newHeat.targetKg} onChange={(e) => setNewHeat({ ...newHeat, targetKg: e.target.value })} /></Field>
            <Button size="sm" className="w-full mt-3" onClick={createHeat}><Plus size={14} className="mr-1" />Plan heat</Button>
          </Card>
        </div>

        {!heat && (booting || heatId) && (
          <div className="rounded-2xl border border-metal-200 bg-white shadow-metal">
            <MeltSpinner label="Loading heats and charge…" sublabel="Reading stock, QA and gate history" className="py-14" />
          </div>
        )}
        {heat && (
          <div className="space-y-6">
            <Interlock heat={heat} gate={gate} dirty={dirty} onGatePassed={gatePassed} onContinue={continueToAI} onStarted={() => { loadHeat(heat.heatId); loadHeats(heat.heatId); loadLots(); loadAudit(); }} />
            {heat.status !== "PLANNED" && (
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" size="sm" onClick={() => navigate("/spectrometer")}><Microscope size={16} className="mr-2" />Take first melt-in reading</Button>
              </div>
            )}

            <Card title={`Charge — ${heat.heatId} · ${heat.grade} · target ${kg(heat.targetKg)}`} actions={planned && (
              <div className="flex gap-2">
                {dirty && <Button size="sm" variant="ghost" onClick={() => saveCharge().then(() => toast.success("Charge saved")).catch((e) => toast.error(errMsg(e)))}>Save</Button>}
                <Button size="sm" onClick={check} loading={checking} disabled={!charge.some((l) => l.lotId)}><ShieldCheck size={14} className="mr-1" />Run pre-melt check</Button>
              </div>
            )}>
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-metal-500 border-b border-metal-200"><th className="px-2 py-2">Lot</th><th className="px-2">Status</th><th className="px-2 text-right">kg</th><th className="px-2 text-right">Share</th><th className="px-2 text-right">In stock</th><th /></tr></thead>
                  <tbody>
                    {charge.map((l, i) => {
                      const lot = lotById[l.lotId];
                      const share = chargeKg > 0 ? (Number(l.kg) / chargeKg) * 100 : 0;
                      const over = lot?.restriction && share > lot.restriction.maxSharePct;
                      return (
                        <tr key={i} className="border-b border-metal-100">
                          <td className="px-2 py-2">
                            {planned ? (
                              <select className={clsx(inputCls, "py-1.5")} value={l.lotId} onChange={(e) => editLine(i, { lotId: e.target.value })} aria-label="Lot">
                                <option value="">Choose lot…</option>
                                {selectableLots.map((x) => <option key={x.lotId} value={x.lotId}>{x.lotId} · {x.alloyName || x.description}</option>)}
                              </select>
                            ) : <span className="font-mono">{l.lotId}</span>}
                          </td>
                          <td className="px-2">{lot && <StatusPill status={lot.status} />}{over && <span className="block text-[11px] text-red-700 font-semibold">over {lot.restriction.maxSharePct}% limit</span>}</td>
                          <td className="px-2 text-right">
                            {planned ? <input type="number" min="0" step="0.1" className={clsx(inputCls, "py-1.5 w-24 text-right")} value={l.kg} onChange={(e) => editLine(i, { kg: e.target.value })} aria-label="kg" /> : kg(l.kg)}
                          </td>
                          <td className="px-2 text-right tabular-nums text-metal-700">{share.toFixed(1)}%</td>
                          <td className="px-2 text-right tabular-nums text-xs text-metal-500 whitespace-nowrap">{lot ? kg(lot.availableKg) : "—"}</td>
                          <td className="px-2 text-right">{planned && <button onClick={() => removeLine(i)} className="text-metal-400 hover:text-red-600 p-1" aria-label="Remove line"><Trash2 size={15} /></button>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot><tr><td className="px-2 pt-3">{planned && <Button size="sm" variant="ghost" onClick={addLine}><Plus size={14} className="mr-1" />Add lot</Button>}</td><td /><td className="px-2 pt-3 text-right font-bold tabular-nums">{kg(chargeKg)}</td><td colSpan={3} /></tr></tfoot>
                </table>
              </div>
              {dirty && gate && <p className="text-xs text-amber-700 mt-2">The charge changed — the last check no longer applies.</p>}
            </Card>


          </div>
        )}
      </div>

      {heat && gate && (
        <div className="space-y-6">
            <Card title="Checks">
              {gate.checks.map((c) => <CheckRow key={c.id} c={c} />)}
            </Card>

            {gate.prediction && (
              <div className="grid xl:grid-cols-2 gap-6">
                <Card title="Predicted melt-down chemistry">
                  <p className="text-xs text-metal-500 mb-2">Marker = prediction, faint band = ±2σ uncertainty, green zone = grade limits. Fe is the balance ({gate.prediction.composition.Fe}%) and has no limit. Limits: {gate.spec.source}.</p>
                  {["C", "Si", "Mn", "P", "S"].filter((el) => specRanges[el]).map((el) => (
                    <ChemBar key={el} element={el} value={gate.prediction.composition[el]} sigma={gate.prediction.sigma[el]}
                      min={["P", "S"].includes(el) ? null : specRanges[el][0]} max={specRanges[el][1]} status={statusOf(specDetail, el)} />
                  ))}
                  {gate.spec.residualLimits && (
                    <>
                      <p className="text-xs font-semibold text-metal-700 mt-4 mb-1">Residuals</p>
                      {Object.entries(gate.spec.residualLimits).map(([el, max]) => (
                        <ChemBar key={el} element={el} value={gate.prediction.composition[el]} sigma={gate.prediction.sigma[el]} min={null} max={max} status={statusOf(residualDetail, el)} />
                      ))}
                    </>
                  )}
                  <p className="text-xs text-metal-500 mt-3">{kg(gate.prediction.chargeKg)} charged → about {kg(gate.prediction.metalKg)} liquid metal.</p>
                </Card>

                <Card title="AI assessment">
                  {!gate.ai ? (
                    <p className="text-sm text-red-700">{gate.checks.find((c) => c.id === "ai_assessment")?.summary}</p>
                  ) : (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        {[["As charged", gate.ai.before_correction], ["After AI additions", gate.ai.after_correction || gate.ai.before_correction]].map(([t, r]) => (
                          <RiskDial key={t} value={r.risk} label={t} sub={`off-spec risk · ${pct(r.risk_band_p10_p90[0])}–${pct(r.risk_band_p10_p90[1])}`} />
                        ))}
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-metal-700 mb-1">What drives the risk</p>
                        {gate.ai.before_correction.drivers.filter((d) => (d.impact ?? d.risk_drop_if_normal) > 0.1).slice(0, 3).map((d) => (
                          <p key={d.element} className="text-sm text-metal-700">
                            <strong className="font-mono">{d.element}</strong> {Number(d.value).toFixed(3)}% vs {Number(d.normal_mean).toFixed(3)}% in normal heats
                            <span className="text-metal-500"> · alone would give {pct(d.risk_if_only_this ?? 0)} risk</span>
                          </p>
                        ))}
                        {!gate.ai.before_correction.drivers.some((d) => (d.impact ?? d.risk_drop_if_normal) > 0.1) && <p className="text-sm text-metal-600">No element stands out.</p>}
                      </div>
                      {gate.suggestedAdditions.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-metal-700 mb-1 flex items-center gap-1"><Sparkles size={13} className="text-emerald-600" />Alloy Correction Agent — from in-stock lots</p>
                          <table className="w-full text-sm">
                            <tbody>
                              {gate.suggestedAdditions.map((a) => (
                                <tr key={a.element} className="border-b border-metal-100">
                                  <td className="py-1.5 font-mono font-bold">+{a.pct}% {a.element}</td>
                                  <td className="text-metal-700">{a.kg !== null ? `${a.kg} kg ${a.alloyName}` : a.alloyName}</td>
                                  <td className="font-mono text-xs text-primary-700">{a.lotId || "—"}</td>
                                  <td className="text-right tabular-nums text-metal-600">{a.costRs !== null ? `₹${a.costRs.toLocaleString("en-IN")}` : a.note}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {planned && gate.suggestedAdditions.some((a) => a.lotId && a.inStock) && (
                            <Button size="sm" variant="outline" className="mt-3" onClick={applyAdditions}>Add these to the charge</Button>
                          )}
                        </div>
                      )}
                      <p className="text-[11px] text-metal-500">Model: {gate.ai.model.type} · holdout AUC {gate.ai.model.metrics?.holdout_auc ?? "—"} for {gate.spec.grade}. Advisory — the gate combines it with the lot, QA and inspection checks.</p>
                    </div>
                  )}
                </Card>
              </div>
            )}

            {gate.prediction && (
              <Card title="Where the metal comes from">
                <div className="overflow-x-auto -mx-2">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-metal-500 border-b border-metal-200"><th className="px-2 py-2">Lot</th><th className="px-2 text-right">Charged</th><th className="px-2 text-right">Metal yield</th><th className="px-2 text-right">Share of metal</th><th className="px-2">Chemistry from</th></tr></thead>
                    <tbody>
                      {gate.prediction.lines.map((l) => (
                        <tr key={l.lotId} className="border-b border-metal-100">
                          <td className="px-2 py-1.5 font-mono">{l.lotId}</td>
                          <td className="px-2 text-right tabular-nums">{kg(l.kg)}</td>
                          <td className="px-2 text-right tabular-nums">{l.yieldPct}%</td>
                          <td className="px-2 text-right tabular-nums">{l.metalSharePct}%</td>
                          <td className="px-2 text-xs text-metal-600">{SOURCE_LABEL[l.chemistrySource]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
        </div>
      )}

      <Card title="Audit trail">
        {audit.map((a, i) => (
          <div key={i} className="grid grid-cols-[6.5rem_12rem_1fr] gap-3 text-xs border-b border-metal-100 last:border-0 py-2 items-start">
            <span className="text-metal-400 font-mono tabular-nums flex items-center gap-1.5"><span className={clsx("w-1.5 h-1.5 rounded-full", a.type.includes("OVERRIDE") ? "bg-red-500" : "bg-primary-400")} />{new Date(a.at).toLocaleTimeString()}</span>
            <span className={clsx("font-semibold", a.type.includes("OVERRIDE") ? "text-red-700" : "text-metal-800")}>{a.type.replaceAll("_", " ").toLowerCase()} · {a.ref}</span>
            <span className="text-metal-600">{a.by}: {a.detail}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
