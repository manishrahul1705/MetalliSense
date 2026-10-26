import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import toast from "react-hot-toast";
import {
  Trophy, Truck, ShieldCheck, SlidersHorizontal, X, TrendingDown, TrendingUp, AlertTriangle, RefreshCw,
  Scale, ShoppingCart, GitCompare, Bell, Minus, CheckCircle2, XCircle,
} from "lucide-react";
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceArea,
} from "recharts";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import { MeltSpinner } from "../components/common/FurnaceLoader";
import { StatusPill, errMsg, inputCls } from "../components/premelt/premeltUi";
import {
  getSupplierScorecard, updateSupplierWeights, getSupplierAhp, updateSupplierAhp, getOrderPlan,
} from "../services/insightsService";

// ─────────────────────────────────────────────── constants
const GRADE_STYLE = {
  A: "bg-emerald-600 text-white",
  B: "bg-sky-600 text-white",
  C: "bg-amber-500 text-metal-950",
  D: "bg-red-700 text-white",
  NEW: "bg-metal-200 text-metal-700",
};
const PILLAR = {
  quality: { label: "Quality", short: "Q", bar: "bg-emerald-500", text: "text-emerald-700", soft: "bg-emerald-50 ring-emerald-200", hex: "#10b981" },
  cost: { label: "Cost", short: "C", bar: "bg-sky-500", text: "text-sky-700", soft: "bg-sky-50 ring-sky-200", hex: "#0ea5e9" },
  delivery: { label: "Delivery", short: "D", bar: "bg-amber-500", text: "text-amber-700", soft: "bg-amber-50 ring-amber-200", hex: "#f59e0b" },
  service: { label: "Service", short: "S", bar: "bg-violet-500", text: "text-violet-700", soft: "bg-violet-50 ring-violet-200", hex: "#8b5cf6" },
};
const PILLAR_KEYS = Object.keys(PILLAR);
const TYPE_TABS = [
  ["", "All materials"],
  ["STEEL_SCRAP", "Steel scrap"],
  ["CI_SCRAP", "Cast iron scrap"],
  ["DRI", "Sponge iron"],
  ["PIG_IRON", "Pig iron"],
  ["FERROALLOY", "Ferro-alloys"],
];
const VIEW_TABS = [["overall", "Overall (QCDS)"], ...PILLAR_KEYS.map((k) => [k, `${PILLAR[k].label} only`])];
const ALERT_STYLE = {
  error: { cls: "border-red-200 bg-red-50 text-red-900", icon: XCircle, ic: "text-red-600" },
  warning: { cls: "border-amber-200 bg-amber-50 text-amber-900", icon: AlertTriangle, ic: "text-amber-600" },
  success: { cls: "border-emerald-200 bg-emerald-50 text-emerald-900", icon: TrendingUp, ic: "text-emerald-600" },
  info: { cls: "border-sky-200 bg-sky-50 text-sky-900", icon: Bell, ic: "text-sky-600" },
};
const AHP_PAIRS = [
  ["quality", "cost"], ["quality", "delivery"], ["quality", "service"],
  ["cost", "delivery"], ["cost", "service"], ["delivery", "service"],
];
const RI = { 4: 0.9 };
const TYPE_ORDER = ["STEEL_SCRAP", "CI_SCRAP", "DRI", "PIG_IRON", "FERROALLOY"];
const typeRank = (t) => (TYPE_ORDER.indexOf(t) === -1 ? 99 : TYPE_ORDER.indexOf(t));

const rs = (v) => (v === null || v === undefined ? "—" : `₹${Math.round(Number(v)).toLocaleString("en-IN")}`);
const scoreColor = (s) => (s === null || s === undefined ? "bg-metal-300" : s >= 85 ? "bg-emerald-500" : s >= 70 ? "bg-sky-500" : s >= 50 ? "bg-amber-500" : "bg-red-600");
const scoreText = (s) => (s === null || s === undefined ? "text-metal-400" : s >= 85 ? "text-emerald-700" : s >= 70 ? "text-sky-700" : s >= 50 ? "text-amber-700" : "text-red-700");

// ─────────────────────────────────────────────── small pieces
function GradeBadge({ grade, big }) {
  return (
    <span className={clsx("inline-grid place-items-center font-black rounded-lg", big ? "w-12 h-12 text-2xl" : "w-8 h-8 text-sm", GRADE_STYLE[grade] || GRADE_STYLE.NEW)}>
      {grade === "NEW" ? "N" : grade}
    </span>
  );
}

function ScoreBar({ score }) {
  return (
    <div className="flex items-center gap-2 min-w-[7rem]">
      <div className="h-2 flex-1 rounded-full bg-metal-100 overflow-hidden">
        <div className={clsx("h-full rounded-full transition-all duration-700", scoreColor(score))} style={{ width: `${score ?? 0}%` }} />
      </div>
      <span className="w-8 text-right text-sm font-bold tabular-nums text-metal-900">{score ?? "—"}</span>
    </div>
  );
}

function PillarCell({ p }) {
  if (!p || p.score === null) return <span className="text-metal-300 text-xs">—</span>;
  return (
    <span className="inline-flex flex-col items-center leading-none">
      <b className={clsx("tabular-nums text-sm", scoreText(p.score))}>{p.score}</b>
      <span className="text-[10px] text-metal-400 mt-0.5">#{p.rank}</span>
    </span>
  );
}

function Sparkline({ trend, direction }) {
  const pts = (trend || []).map((t, i) => ({ i, v: t.score })).filter((p) => p.v !== null && p.v !== undefined);
  if (pts.length < 2) return <span className="text-[11px] text-metal-400">not enough history</span>;
  const n = (trend || []).length - 1 || 1;
  const W = 64;
  const H = 22;
  const path = pts.map((p) => `${(p.i / n) * W},${H - (Math.max(0, Math.min(100, p.v)) / 100) * H}`).join(" ");
  const color = direction === "improving" ? "#059669" : direction === "declining" ? "#dc2626" : "#64748b";
  const Icon = direction === "improving" ? TrendingUp : direction === "declining" ? TrendingDown : Minus;
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={W} height={H} className="overflow-visible" aria-hidden="true">
        <polyline points={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.length > 0 && <circle cx={(pts[pts.length - 1].i / n) * W} cy={H - (pts[pts.length - 1].v / 100) * H} r="2.5" fill={color} />}
      </svg>
      <Icon size={13} style={{ color }} />
    </span>
  );
}

function GradeScale({ score }) {
  const bands = [["D", 0, 50, "bg-red-200"], ["C", 50, 70, "bg-amber-200"], ["B", 70, 85, "bg-sky-200"], ["A", 85, 100, "bg-emerald-200"]];
  return (
    <div>
      <div className="relative h-3 flex rounded-full overflow-hidden">
        {bands.map(([g, lo, hi, cls]) => <div key={g} className={cls} style={{ width: `${hi - lo}%` }} />)}
        {score !== null && <div className="absolute -top-1 w-1 h-5 rounded bg-metal-900" style={{ left: `calc(${score}% - 2px)` }} />}
      </div>
      <div className="relative h-4 text-[10px] text-metal-500 mt-1">
        {bands.map(([g, lo, hi]) => <span key={g} className="absolute font-semibold" style={{ left: `${(lo + hi) / 2}%`, transform: "translateX(-50%)" }}>{g}</span>)}
        {[50, 70, 85].map((t) => <span key={t} className="absolute tabular-nums" style={{ left: `${t}%`, transform: "translateX(-50%)", top: 12 }}>{t}</span>)}
      </div>
    </div>
  );
}

function Section({ n, title, children, hint }) {
  return (
    <section className="rounded-2xl bg-white ring-1 ring-metal-200 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-2">
        <span className="grid place-items-center w-6 h-6 rounded-full bg-metal-900 text-white text-[11px] font-black">{n}</span>
        <h3 className="text-sm font-bold text-metal-900">{title}</h3>
      </div>
      {hint && <p className="text-xs text-metal-500 mb-2 ml-8">{hint}</p>}
      <div className="ml-8">{children}</div>
    </section>
  );
}

// ─────────────────────────────────────────────── AHP
// Client-side AHP so the consistency ratio updates while the sliders move.
function ahpLocal(j) {
  const A = PILLAR_KEYS.map(() => PILLAR_KEYS.map(() => 1));
  PILLAR_KEYS.forEach((a, i) => PILLAR_KEYS.forEach((b, k) => {
    if (i >= k) return;
    const v = Number(j[`${a}:${b}`]) || 1;
    A[i][k] = v;
    A[k][i] = 1 / v;
  }));
  const n = PILLAR_KEYS.length;
  const gm = A.map((row) => row.reduce((p, x) => p * x, 1) ** (1 / n));
  const sum = gm.reduce((a, b) => a + b, 0);
  const w = gm.map((g) => g / sum);
  const Aw = A.map((row) => row.reduce((s, x, k) => s + x * w[k], 0));
  const lambda = Aw.reduce((s, v, i) => s + v / w[i], 0) / n;
  const CR = (lambda - n) / (n - 1) / RI[n];
  return { w, CR, lambda };
}
// Slider position −8…+8  ↔  Saaty value 1/9…9
const toSlider = (v) => (v >= 1 ? Math.round(v - 1) : -Math.round(1 / v - 1));
const fromSlider = (x) => (x >= 0 ? x + 1 : 1 / (1 - x));

function AhpPanel({ onApplied, onClose, onManual }) {
  const [data, setData] = useState(null);
  const [j, setJ] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    getSupplierAhp().then((r) => { setData(r.data.data); setJ(r.data.data.judgements); }).catch((e) => toast.error(errMsg(e)));
  }, []);
  if (!data || !j) return <Card title="AHP weights"><MeltSpinner label="Loading AHP judgements…" /></Card>;
  const res = ahpLocal(j);
  const consistent = res.CR < 0.1;
  const apply = async () => {
    setSaving(true);
    try {
      await updateSupplierAhp(j, true);
      toast.success("AHP weights applied — suppliers re-ranked");
      onApplied();
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  return (
    <Card title="How important is each pillar? (AHP)" actions={<button onClick={onClose} className="p-1 text-metal-400 hover:text-metal-700" aria-label="Close"><X size={18} /></button>}>
      <p className="text-xs text-metal-600 mb-4 max-w-3xl">
        The Analytic Hierarchy Process turns six pairwise judgements into pillar weights. Move each slider towards the pillar that matters more
        (Saaty scale 1–9). The consistency ratio (CR) checks the judgements do not contradict each other — it must stay below 0.10.
      </p>
      <div className="grid lg:grid-cols-[1fr_18rem] gap-6">
        <div className="space-y-3">
          {AHP_PAIRS.map(([a, b]) => {
            const key = `${a}:${b}`;
            const v = Number(j[key]) || 1;
            const x = toSlider(v);
            const text = x === 0 ? `${PILLAR[a].label} and ${PILLAR[b].label} are equally important`
              : x > 0 ? `${PILLAR[a].label} is ${x + 1}× as important as ${PILLAR[b].label}`
                : `${PILLAR[b].label} is ${1 - x}× as important as ${PILLAR[a].label}`;
            return (
              <div key={key}>
                <div className="grid grid-cols-[5rem_1fr_5rem] items-center gap-3 text-xs">
                  <span className={clsx("font-bold text-right", PILLAR[a].text)}>{PILLAR[a].label}</span>
                  <input type="range" min="-8" max="8" step="1" value={-x} onChange={(e) => setJ({ ...j, [key]: fromSlider(-Number(e.target.value)) })} className="w-full accent-metal-800" aria-label={`${PILLAR[a].label} versus ${PILLAR[b].label}`} />
                  <span className={clsx("font-bold", PILLAR[b].text)}>{PILLAR[b].label}</span>
                </div>
                <p className="text-center text-[11px] text-metal-500">{text}</p>
              </div>
            );
          })}
        </div>
        <div className="space-y-3">
          <p className="text-xs font-bold text-metal-700 uppercase tracking-wider">Resulting weights</p>
          {PILLAR_KEYS.map((k, i) => (
            <div key={k} className="grid grid-cols-[4.5rem_1fr_3rem] items-center gap-2 text-xs">
              <span className={clsx("font-semibold", PILLAR[k].text)}>{PILLAR[k].label}</span>
              <div className="h-2.5 rounded-full bg-metal-100 overflow-hidden"><div className={clsx("h-full rounded-full", PILLAR[k].bar)} style={{ width: `${res.w[i] * 100}%` }} /></div>
              <span className="text-right tabular-nums font-bold">{(res.w[i] * 100).toFixed(1)}%</span>
            </div>
          ))}
          <div className={clsx("rounded-lg px-3 py-2 text-xs ring-1", consistent ? "bg-emerald-50 ring-emerald-200 text-emerald-900" : "bg-red-50 ring-red-200 text-red-900")}>
            <p className="font-bold flex items-center gap-1.5">{consistent ? <CheckCircle2 size={14} /> : <XCircle size={14} />}CR = {res.CR.toFixed(3)} {consistent ? "— consistent" : "— inconsistent"}</p>
            <p className="mt-0.5 opacity-80">λmax {res.lambda.toFixed(3)}, CI = (λmax − 4) ÷ 3, RI = 0.90</p>
          </div>
          <p className="text-[11px] text-metal-500">Each pillar's weight is then split between its criteria (e.g. Quality: acceptance 40%, declaration accuracy 22%, clean pieces 20%, heat impact 18%).</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={apply} loading={saving} disabled={!consistent}>Apply AHP weights</Button>
            <Button size="sm" variant="ghost" onClick={onManual}>Fine-tune criteria</Button>
          </div>
          {data.weightsSource === "MANUAL" && <p className="text-[11px] text-amber-700">Criteria weights are currently set by hand. Applying AHP replaces them.</p>}
        </div>
      </div>
    </Card>
  );
}

function WeightsEditor({ criteria, weights, onSaved, onClose }) {
  const [w, setW] = useState(weights);
  const total = Object.values(w).reduce((a, b) => a + Number(b || 0), 0);
  const save = async () => {
    try {
      await updateSupplierWeights(w);
      toast.success("Weights updated — ranking recalculated");
      onSaved();
    } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Card title="Criteria weights (manual)" actions={<button onClick={onClose} className="p-1 text-metal-400 hover:text-metal-700" aria-label="Close"><X size={18} /></button>}>
      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
        {criteria.map((c) => (
          <label key={c.key} className="flex items-center gap-3 text-sm">
            <span className={clsx("w-1.5 h-6 rounded-full", PILLAR[c.pillar].bar)} />
            <span className="w-52 text-metal-700 font-medium">{c.label}</span>
            <input type="range" min="0" max="40" value={w[c.key] ?? 0} onChange={(e) => setW({ ...w, [c.key]: Number(e.target.value) })} className="flex-1 accent-primary-600" />
            <span className="w-10 text-right tabular-nums font-bold">{w[c.key]}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between mt-4">
        <p className="text-xs text-metal-500">Total {total}. Weights are re-normalised, so they do not need to add up to 100.</p>
        <Button size="sm" onClick={save}>Apply weights</Button>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────── alerts, methods, order plan
function AlertsPanel({ alerts }) {
  const [all, setAll] = useState(false);
  if (!alerts?.length) return null;
  const shown = all ? alerts : alerts.slice(0, 4);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Bell size={16} className="text-amber-600" />Supplier alerts ({alerts.length})</span>}>
      <div className="grid md:grid-cols-2 gap-2">
        {shown.map((a, i) => {
          const st = ALERT_STYLE[a.level] || ALERT_STYLE.info;
          return (
            <div key={i} className={clsx("flex gap-2 rounded-lg border px-3 py-2 text-xs", st.cls)}>
              <st.icon size={15} className={clsx("shrink-0 mt-0.5", st.ic)} />
              <span>{a.text}</span>
            </div>
          );
        })}
      </div>
      {alerts.length > 4 && (
        <button onClick={() => setAll(!all)} className="mt-2 text-xs font-semibold text-primary-700 hover:underline">{all ? "Show fewer" : `Show all ${alerts.length}`}</button>
      )}
    </Card>
  );
}

function MethodsCard({ methods }) {
  if (!methods?.length) return null;
  return (
    <Card title={<span className="inline-flex items-center gap-2"><GitCompare size={16} className="text-sky-600" />Cross-check: weighted score vs TOPSIS</span>}>
      <p className="text-xs text-metal-600 mb-3">
        TOPSIS ranks each supplier by how close it is to an ideal supplier (best on every criterion) and how far from the worst.
        If both methods give the same order, the ranking does not depend on the scoring method. Agreement is measured with Spearman's ρ (1 = identical order).
      </p>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-xs min-w-[520px]">
          <thead><tr className="text-left text-[11px] text-metal-500 border-b border-metal-200">
            <th className="px-2 py-2">Material</th><th className="px-2">#1 by score</th><th className="px-2">#1 by TOPSIS</th><th className="px-2 text-right">Spearman ρ</th><th className="px-2">Result</th>
          </tr></thead>
          <tbody>
            {methods.map((m) => (
              <tr key={m.materialLabel || m.materialType} className="border-b border-metal-100">
                <td className="px-2 py-2 font-semibold text-metal-800">{m.materialLabel}</td>
                <td className="px-2">{m.weightedTop}</td>
                <td className="px-2">{m.topsisTop}</td>
                <td className={clsx("px-2 text-right tabular-nums font-bold", m.spearmanRho >= 0.8 ? "text-emerald-700" : "text-amber-700")}>{m.spearmanRho}</td>
                <td className="px-2 text-metal-600">{m.sameTop ? <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold"><CheckCircle2 size={12} />Agree</span> : <span className="text-amber-700 font-semibold">Close call</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function OrderPlanner({ types }) {
  const [type, setType] = useState(types[0]?.[0] || "");
  const [tonnes, setTonnes] = useState(50);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (!type && types[0]) setType(types[0][0]); }, [types, type]);
  const load = useCallback(async () => {
    if (!type) return;
    setLoading(true);
    try {
      const r = await getOrderPlan(type, tonnes);
      setPlan(r.data.data);
    } catch (e) { toast.error(errMsg(e)); } finally { setLoading(false); }
  }, [type, tonnes]);
  useEffect(() => { load(); }, [load]);
  if (!types.length) return null;
  return (
    <Card title={<span className="inline-flex items-center gap-2"><ShoppingCart size={16} className="text-primary-600" />Next purchase: how to split the order</span>}>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-xs font-semibold text-metal-700">Material
          <select className={clsx(inputCls, "mt-1 w-48")} value={type} onChange={(e) => setType(e.target.value)}>
            {types.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-metal-700">Quantity (t)
          <input type="number" min="1" className={clsx(inputCls, "mt-1 w-28")} value={tonnes} onChange={(e) => setTonnes(Number(e.target.value) || 1)} />
        </label>
        <p className="text-[11px] text-metal-500 max-w-md">Share ∝ (score − 40)². Max 60% per supplier (no single-source risk), grade C max 20% (probation), new suppliers max 10% (trial), grade D excluded.</p>
      </div>
      {loading && !plan ? <MeltSpinner label="Planning the order…" /> : plan && (
        <div className="space-y-4">
          <div className="space-y-2">
            {plan.lines.map((l) => (
              <div key={l.supplier} className="grid grid-cols-[2rem_12rem_1fr_4rem_7rem] items-center gap-3 text-xs">
                <GradeBadge grade={l.grade} />
                <span><b className="text-metal-900">{l.supplier}</b><span className="block text-[10.5px] text-metal-500">{l.reason}</span></span>
                <div className="h-3 rounded-full bg-metal-100 overflow-hidden"><div className={clsx("h-full rounded-full", l.sharePct ? "bg-primary-500" : "bg-transparent")} style={{ width: `${l.sharePct}%` }} /></div>
                <span className="text-right tabular-nums font-black text-metal-900">{l.sharePct}%</span>
                <span className="text-right tabular-nums text-metal-600">{l.tonnes} t · {rs(l.effectiveRsPerT)}/t</span>
              </div>
            ))}
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="rounded-xl ring-1 ring-primary-200 bg-primary-50 px-4 py-3">
              <p className="text-[11px] uppercase tracking-wider font-semibold text-primary-700">This split — good metal cost</p>
              <p className="text-xl font-black tabular-nums text-metal-900">{rs(plan.plan?.effectiveRs)}</p>
              <p className="text-[11px] text-metal-500">invoice {rs(plan.plan?.invoiceRs)}</p>
            </div>
            <div className="rounded-xl ring-1 ring-metal-200 bg-white px-4 py-3">
              <p className="text-[11px] uppercase tracking-wider font-semibold text-metal-500">All from cheapest invoice</p>
              <p className="text-xl font-black tabular-nums text-metal-900">{rs(plan.priceOnly?.effectiveRs)}</p>
              <p className="text-[11px] text-metal-500">{plan.priceOnly?.supplier} (grade {plan.priceOnly?.grade}) · invoice {rs(plan.priceOnly?.invoiceRs)}</p>
            </div>
            <div className={clsx("rounded-xl px-4 py-3 ring-1", plan.savingRs > 0 ? "bg-emerald-50 ring-emerald-200" : "bg-metal-50 ring-metal-200")}>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-emerald-700">Saved by buying on score</p>
              <p className="text-xl font-black tabular-nums text-emerald-700">{rs(plan.savingRs)}</p>
              <p className="text-[11px] text-metal-500">on {plan.tonnes} t of {plan.materialLabel?.toLowerCase()}</p>
            </div>
          </div>
          {plan.explanation && <p className="text-xs text-metal-600">{plan.explanation}</p>}
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────── drawer
function SupplierDrawer({ s, trendLabels, windowDays, onClose }) {
  const radar = s.criteria.filter((c) => c.score !== null).map((c) => ({ criterion: c.label.replace(" (gun)", "").replace(" (invoice vs weighbridge)", ""), score: c.score }));
  const e = s.evidence || {};
  const cb = s.costBreakdown;
  const totalPoints = s.criteria.reduce((a, c) => a + (c.points || 0), 0);
  const maxCost = cb ? cb.effectiveRsPerT : 1;
  const trendData = (s.trend || []).map((t) => ({ label: t.label, score: t.score, grade: t.grade }));
  useEffect(() => {
    const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  let n = 0;
  const next = () => String(++n);
  // Rendered into <body> so the full-screen view is not clipped or offset by the page layout.
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-metal-950/50 backdrop-blur-[2px]" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={`${s.supplier} — how this rank was calculated`} className="h-full w-full overflow-y-auto bg-metal-50 shadow-2xl" onClick={(ev) => ev.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-gradient-to-r from-metal-950 via-metal-900 to-primary-950 text-white shadow-lg">
          <div className="max-w-7xl mx-auto px-6 lg:px-8 py-5 grid lg:grid-cols-[1fr_auto] gap-4 items-center">
          <div className="flex items-start gap-4">
            <GradeBadge grade={s.grade} big />
            <div className="flex-1">
              <p className="text-[11px] uppercase tracking-[0.2em] text-primary-300 font-semibold">{s.materialLabel} · rank {s.rank} of {s.rankOf}{s.topsis ? ` · TOPSIS #${s.topsis.rank}` : ""}</p>
              <h2 className="text-xl font-bold">{s.supplier}</h2>
              <p className="text-sm text-white/60">{s.gradeLabel} · inspect {s.inspectPieces} pieces per lot</p>
            </div>
            <button onClick={onClose} className="lg:hidden p-1 text-white/60 hover:text-white" aria-label="Close"><X size={20} /></button>
          </div>
          <div className="flex items-center gap-3">
          <div className="grid grid-cols-4 gap-3 flex-1 lg:w-[34rem]">
            {s.pillars.map((p) => (
              <div key={p.key} className="rounded-lg bg-white/5 ring-1 ring-white/10 px-3 py-2">
                <p className="text-base font-black tabular-nums">{p.score ?? "—"}<span className="text-[10px] font-semibold text-white/50 ml-1">#{p.rank ?? "—"}</span></p>
                <p className="text-[10px] uppercase tracking-wider" style={{ color: PILLAR[p.key].hex }}>{p.label} · {Math.round(p.weightPct)}%</p>
              </div>
            ))}
          </div>
          <button onClick={onClose} className="hidden lg:inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white/80 ring-1 ring-white/20 hover:bg-white/10" aria-label="Close"><X size={16} />Close <span className="text-white/40">Esc</span></button>
          </div>
          </div>
        </div>

        <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-8">
          {s.rankReason && (
            <div className="rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900 flex gap-2">
              <Trophy size={16} className="shrink-0 mt-0.5 text-primary-600" />
              <span>{s.rankReason}</span>
            </div>
          )}

          <div className="grid lg:grid-cols-[1.45fr_1fr] gap-8 items-start">
            <div className="space-y-8 min-w-0">
          <Section n={next()} title="Data used for this ranking" hint={`Deliveries in the last ${windowDays} days. Everything is calculated from records already in the system — no manual rating.`}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                ["Lots received", e.lotsTotal],
                ["Lots decided", e.lotsDecided],
                ["Gun pieces tested", e.piecesTested || 0],
                ["Lab-tested lots", e.labTestedLots || 0],
                ["Heats using them", e.heatsUsed || 0],
                ["Trucks late", `${e.lateLots || 0} of ${e.deliveryLots || 0}`],
                ["Short weight", `${Number(e.shortKg || 0).toLocaleString("en-IN")} kg`],
                ["Documents missing", `${e.docsMissing || 0} of ${e.docsTotal || 0}`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-metal-200 px-3 py-2">
                  <p className="text-lg font-black tabular-nums text-metal-900">{v}</p>
                  <p className="text-[11px] text-metal-500">{k}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section n={next()} title="Score for each criterion, by QCDS pillar" hint="Each criterion is scored 0–100 from the evidence. Criteria without data are skipped and the other weights are scaled up, so missing data never counts against a supplier.">
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs min-w-[560px]">
                <thead>
                  <tr className="text-left text-[11px] text-metal-500 border-b border-metal-200">
                    <th className="py-2 pr-2">Criterion</th><th className="pr-2">Evidence → formula</th><th className="text-right pr-2">Score</th><th className="text-right pr-2">Weight</th><th className="text-right">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {PILLAR_KEYS.map((pk) => {
                    const rows = s.criteria.filter((c) => c.pillar === pk);
                    const pill = s.pillars.find((p) => p.key === pk);
                    return (
                      <React.Fragment key={pk}>
                        <tr className={clsx("ring-1 ring-inset", PILLAR[pk].soft)}>
                          <td colSpan={2} className={clsx("py-1.5 px-2 font-bold uppercase tracking-wider text-[10.5px]", PILLAR[pk].text)}>{PILLAR[pk].label}</td>
                          <td className="text-right pr-2 font-bold tabular-nums">{pill?.score ?? "—"}</td>
                          <td className="text-right pr-2 tabular-nums text-metal-500">{Math.round(pill?.weightPct || 0)}%</td>
                          <td className="text-right font-bold tabular-nums">{pill?.points ?? "—"}</td>
                        </tr>
                        {rows.map((c) => (
                          <tr key={c.key} className={clsx("border-b border-metal-100 align-top", c.score === null && "text-metal-400")}>
                            <td className="py-2 pr-2 pl-2 font-semibold text-metal-800">{c.label}</td>
                            <td className="pr-2 py-2">
                              <p className={c.score === null ? "text-metal-400" : "text-metal-700"}>{c.evidence}</p>
                              <p className="text-[10.5px] text-metal-400 font-mono mt-0.5">{c.formula}</p>
                            </td>
                            <td className="text-right pr-2 py-2">
                              {c.score === null ? <span className="text-[10.5px]">no data</span> : (
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="inline-block w-10 h-1.5 rounded-full bg-metal-100 overflow-hidden"><span className={clsx("block h-full", scoreColor(c.score))} style={{ width: `${c.score}%` }} /></span>
                                  <b className="tabular-nums text-metal-900">{c.score}</b>
                                </span>
                              )}
                            </td>
                            <td className="text-right pr-2 py-2 tabular-nums whitespace-nowrap">{c.weight}%{c.score !== null && <span className="block text-[10px] text-metal-400">→ {c.weightShare}%</span>}</td>
                            <td className="text-right py-2 tabular-nums font-bold text-metal-900">{c.points ?? "—"}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="pt-2 text-right text-metal-600 font-semibold pr-2">Total score = sum of points</td>
                    <td className="pt-2 text-right text-base font-black tabular-nums text-primary-700">{Math.round(totalPoints)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-metal-500 mt-2">Points = score × (weight ÷ total weight of criteria with data). Data coverage {s.coverage}% of all weights.</p>
          </Section>

          </div>
            <div className="space-y-8 min-w-0">
          <Section n={next()} title="Score → grade">
            <GradeScale score={s.score} />
            <p className="text-xs text-metal-600 mt-3">
              {s.grade === "NEW"
                ? `Scored ${s.score ?? "—"}, but graded "New" until at least 3 lots are decided (now ${e.lotsDecided}). New suppliers get 25 pieces inspected per lot.`
                : `Score ${s.score} → grade ${s.grade} (${s.gradeLabel}). This sets inspection to ${s.inspectPieces} gun pieces per lot${s.grade === "D" ? ", and every lot needs a manager's approval before release" : ""}.`}
            </p>
          </Section>

          {trendData.filter((t) => t.score !== null).length >= 2 && (
            <Section n={next()} title="Score trend" hint={`Rolling ${windowDays}-day score at the end of each month. ${s.trendDirection === "improving" ? `Improving: +${s.trendDelta} points.` : s.trendDirection === "declining" ? `Declining: ${s.trendDelta} points.` : "Stable."}`}>
              <div style={{ width: "100%", height: 230 }}>
                <ResponsiveContainer>
                  <LineChart data={trendData} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                    <ReferenceArea y1={0} y2={50} fill="#fee2e2" fillOpacity={0.5} />
                    <ReferenceArea y1={50} y2={70} fill="#fef3c7" fillOpacity={0.5} />
                    <ReferenceArea y1={70} y2={85} fill="#e0f2fe" fillOpacity={0.5} />
                    <ReferenceArea y1={85} y2={100} fill="#d1fae5" fillOpacity={0.5} />
                    <CartesianGrid vertical={false} stroke="#eef1f4" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#4f5f73" }} tickLine={false} axisLine={false} />
                    <YAxis domain={[0, 100]} ticks={[0, 50, 70, 85, 100]} tick={{ fontSize: 10, fill: "#6b7f94" }} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v, _n, p) => [`${v} (grade ${p.payload.grade === "NEW" ? "new" : p.payload.grade})`, "Score"]} />
                    <Line type="monotone" dataKey="score" stroke="#0f172a" strokeWidth={2.5} dot={{ r: 3.5 }} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Section>
          )}

          {radar.length >= 3 && (
            <Section n={next()} title="Criteria profile">
              <div style={{ width: "100%", height: 300 }}>
                <ResponsiveContainer>
                  <RadarChart data={radar} outerRadius="70%">
                    <PolarGrid stroke="#e5eaef" />
                    <PolarAngleAxis dataKey="criterion" tick={{ fontSize: 10, fill: "#4f5f73" }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                    <Radar dataKey="score" stroke="#0fa055" fill="#15c26b" fillOpacity={0.35} strokeWidth={2} />
                    <Tooltip formatter={(v) => `${v}/100`} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </Section>
          )}

          {s.topsis && (
            <Section n={next()} title="TOPSIS check" hint="Distance to the ideal supplier (best on every criterion) and to the worst. Closeness = d⁻ ÷ (d⁺ + d⁻); 1 is ideal.">
              <div className="grid grid-cols-4 gap-2 text-center">
                {[["Closeness", s.topsis.closeness], ["TOPSIS rank", `#${s.topsis.rank}`], ["d⁺ (to ideal)", s.topsis.dPlus], ["d⁻ (to worst)", s.topsis.dMinus]].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-metal-200 px-2 py-2"><p className="text-base font-black tabular-nums">{v}</p><p className="text-[10.5px] text-metal-500">{k}</p></div>
                ))}
              </div>
            </Section>
          )}

          </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-8 items-start">
            <div className="min-w-0">{cb && (
            <Section n={next()} title="True cost of good metal" hint="Invoice price is only the start: lost yield and rejected lots raise what a tonne of usable metal really costs.">
              <div className="space-y-2">
                {[
                  ["Invoice price", cb.invoiceRsPerT, "bg-metal-400", ""],
                  ["+ Yield loss", cb.yieldLossRsPerT, "bg-amber-500", `only ${cb.yieldPct}% becomes metal`],
                  ["+ Rejection cost", cb.rejectCostRsPerT, "bg-red-500", `${cb.rejectSharePct}% not released × ₹${cb.rejectPenaltyRsPerKg}/kg handling`],
                ].map(([k, v, cls, note]) => (
                  <div key={k} className="grid grid-cols-[8.5rem_1fr_6rem] items-center gap-3 text-xs">
                    <span className="text-metal-700 font-medium">{k}{note && <span className="block text-[10px] text-metal-400 font-normal">{note}</span>}</span>
                    <div className="h-2.5 rounded-full bg-metal-100 overflow-hidden"><div className={clsx("h-full rounded-full", cls)} style={{ width: `${Math.max(1, (v / maxCost) * 100)}%` }} /></div>
                    <span className="text-right tabular-nums font-semibold">{rs(v)}</span>
                  </div>
                ))}
                <div className="grid grid-cols-[8.5rem_1fr_6rem] items-center gap-3 text-xs border-t border-metal-200 pt-2">
                  <span className="font-bold text-metal-900">= Effective ₹/t</span>
                  <div className="h-2.5 rounded-full bg-metal-900" />
                  <span className="text-right tabular-nums font-black text-metal-900">{rs(cb.effectiveRsPerT)}</span>
                </div>
              </div>
            </Section>
          )}</div>
            <div className="min-w-0">{s.rankVs && (
            <Section n={next()} title={`Compared with #${s.rankVs.rank} ${s.rankVs.supplier}`} hint={`Score ${s.score} vs ${s.rankVs.score} — difference in points per criterion.`}>
              <div className="space-y-1.5">
                {s.rankVs.diffs.map((d) => {
                  const w = Math.min(100, Math.abs(d.delta) * 4);
                  return (
                    <div key={d.label} className="grid grid-cols-[12rem_1fr_4rem] items-center gap-3 text-xs">
                      <span className="text-metal-700 inline-flex items-center gap-1.5"><span className={clsx("w-1.5 h-3 rounded-full", PILLAR[d.pillar]?.bar)} />{d.label}</span>
                      <div className="relative h-2.5 bg-metal-100 rounded-full">
                        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-metal-300" />
                        <div className={clsx("absolute top-0 bottom-0 rounded-full", d.delta >= 0 ? "bg-emerald-500 left-1/2" : "bg-red-500 right-1/2")} style={{ width: `${w / 2}%` }} />
                      </div>
                      <span className={clsx("text-right tabular-nums font-semibold", d.delta > 0 ? "text-emerald-700" : d.delta < 0 ? "text-red-700" : "text-metal-500")}>{d.delta > 0 ? "+" : ""}{d.delta}</span>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}</div>
          </div>

          <div className="grid gap-8">
            <div className="min-w-0"><Section n={next()} title="Evidence per lot">
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs min-w-[640px]">
                <thead><tr className="text-left text-[11px] text-metal-500 border-b border-metal-200">
                  <th className="py-2">Lot</th><th>Received</th><th>Decision</th><th className="text-right">Accuracy</th><th className="text-right">Gun flagged</th><th className="text-right">Yield</th><th className="text-right">Late</th><th className="text-right">Short</th><th className="text-right">₹/kg</th>
                </tr></thead>
                <tbody>
                  {(s.perLot || []).map((l) => (
                    <tr key={l.lotId} className="border-b border-metal-100">
                      <td className="py-2 font-mono font-bold">{l.lotId}</td>
                      <td className="text-metal-500">{l.receivedAt ? new Date(l.receivedAt).toLocaleDateString() : "—"}</td>
                      <td><StatusPill status={l.status} /></td>
                      <td className="text-right tabular-nums">{l.accuracy === null ? "—" : `${l.accuracy}%`}</td>
                      <td className="text-right tabular-nums">{l.gun ? `${l.gun.flagged}/${l.gun.piecesTested}` : "—"}</td>
                      <td className="text-right tabular-nums">{l.yieldPct === null ? "—" : `${l.yieldPct}%`}</td>
                      <td className={clsx("text-right tabular-nums", l.lateDays > 0.5 && "text-red-700 font-semibold")}>{l.lateDays === null ? "—" : l.lateDays > 0.5 ? `${l.lateDays} d` : "on time"}</td>
                      <td className={clsx("text-right tabular-nums", l.shortPct > 2 && "text-red-700 font-semibold")}>{l.shortPct === null ? "—" : `${l.shortPct}%`}</td>
                      <td className="text-right tabular-nums">{l.costPerKg ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section></div>
            <div className="min-w-0">{s.accuracyDetail?.length > 0 && (() => {
            const els = [...new Set(s.accuracyDetail.map((x) => x.element))];
            const lots = [...new Set(s.accuracyDetail.map((x) => x.lotId))];
            const cell = (lot, el) => s.accuracyDetail.find((x) => x.lotId === lot && x.element === el);
            const tone = (v) => (v > 20 ? "bg-red-100 text-red-800" : v > 8 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800");
            return (
              <Section n={next()} title="Declared vs tested chemistry" hint="Error between the supplier's declared value and our lab result, per element. Hover a cell for the two values. Green ≤ 8%, amber ≤ 20%, red above.">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-[11px] text-metal-500 border-b border-metal-200"><th className="py-1.5 text-left">Lot</th>{els.map((el) => <th key={el} className="px-1 text-center font-mono">{el}</th>)}</tr></thead>
                    <tbody>
                      {lots.map((lot) => (
                        <tr key={lot} className="border-b border-metal-100">
                          <td className="py-1.5 pr-2 font-mono font-bold whitespace-nowrap">{lot}</td>
                          {els.map((el) => {
                            const c = cell(lot, el);
                            return (
                              <td key={el} className="px-0.5 py-1 text-center">
                                {c ? <span title={`${el}: declared ${c.declared}, tested ${c.tested}`} className={clsx("inline-block min-w-[2.6rem] rounded px-1 py-0.5 tabular-nums font-semibold", tone(c.errorPct))}>{Math.round(c.errorPct)}%</span> : <span className="text-metal-300">—</span>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            );
          })()}</div>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────── page
export default function SupplierScorecard() {
  const [type, setType] = useState("");
  const [view, setView] = useState("overall");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [panel, setPanel] = useState(null); // "ahp" | "manual" | null

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getSupplierScorecard(type || undefined);
      setData(r.data.data);
    } catch (e) {
      toast.error(errMsg(e, "Could not load the supplier scorecard"));
    } finally {
      setLoading(false);
    }
  }, [type]);
  useEffect(() => { load(); }, [load]);

  const suppliers = data?.suppliers || [];
  const kpis = useMemo(() => {
    const hidden = suppliers.reduce((sum, s) => sum + (s.effectiveRsPerT && s.invoiceRsPerT ? ((s.effectiveRsPerT - s.invoiceRsPerT) * (s.receivedKg || 0)) / 1000 : 0), 0);
    return {
      count: suppliers.length,
      gradeA: suppliers.filter((s) => s.grade === "A").length,
      atRisk: suppliers.filter((s) => s.grade === "C" || s.grade === "D").length,
      hidden: Math.round(hidden),
    };
  }, [suppliers]);

  const grouped = useMemo(() => {
    const g = {};
    [...suppliers].sort((a, b) => typeRank(a.materialType) - typeRank(b.materialType)).forEach((s) => { (g[s.materialLabel] = g[s.materialLabel] || []).push(s); });
    return Object.entries(g).map(([label, list]) => {
      if (view === "overall") return [label, [...list].sort((a, b) => a.rank - b.rank)];
      const ps = (s) => s.pillars.find((p) => p.key === view)?.score ?? -1;
      return [label, [...list].sort((a, b) => ps(b) - ps(a))];
    });
  }, [suppliers, view]);

  // Materials with at least two priced suppliers can be split.
  const orderTypes = useMemo(() => {
    const m = {};
    suppliers.filter((s) => s.effectiveRsPerT && s.materialType !== "FERROALLOY").forEach((s) => { m[s.materialType] = m[s.materialType] || { label: s.materialLabel, n: 0 }; m[s.materialType].n += 1; });
    return Object.entries(m).filter(([, v]) => v.n >= 2).sort(([a], [b]) => typeRank(a) - typeRank(b)).map(([k, v]) => [k, v.label]);
  }, [suppliers]);

  const pillarLine = data?.pillars?.map((p) => `${p.label} ${Math.round(p.weight)}%`).join(" · ");

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-metal-950 via-metal-900 to-primary-950 text-white p-6 md:p-8 shadow-metal-xl">
        <div className="pointer-events-none absolute -top-24 -right-16 w-80 h-80 rounded-full bg-primary-500/20 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="grid place-items-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-400 to-primary-700 shadow-lg ring-1 ring-white/20"><Trophy size={28} /></span>
            <div>
              <p className="text-[11px] uppercase tracking-[0.25em] text-primary-300 font-semibold">Raw material intelligence · QCDS</p>
              <h1 className="text-3xl font-black tracking-tight">Supplier Scorecard</h1>
              <p className="text-white/60 text-sm max-w-2xl mt-1">
                Suppliers ranked on <b className="text-emerald-300">Quality</b>, <b className="text-sky-300">Cost</b>, <b className="text-amber-300">Delivery</b> and <b className="text-violet-300">Service</b> — from lots, gun inspections, lab results and heats already in the system. Weights by AHP, ranking cross-checked with TOPSIS.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setPanel(panel === "ahp" ? null : "ahp")} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white/80 ring-1 ring-white/15 hover:bg-white/10"><Scale size={13} />AHP weights</button>
            <button onClick={() => setPanel(panel === "manual" ? null : "manual")} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white/80 ring-1 ring-white/15 hover:bg-white/10"><SlidersHorizontal size={13} />Criteria</button>
            <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white/80 ring-1 ring-white/15 hover:bg-white/10"><RefreshCw size={13} />Refresh</button>
          </div>
        </div>
        <div className="relative grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          {[
            [Truck, "Suppliers ranked", kpis.count, "text-white"],
            [ShieldCheck, "Grade A suppliers", kpis.gradeA, "text-emerald-300"],
            [AlertTriangle, "Grade C / D (watch)", kpis.atRisk, "text-amber-300"],
            [TrendingDown, "Hidden cost vs invoice", `₹${kpis.hidden.toLocaleString("en-IN")}`, "text-red-300"],
          ].map(([Icon, l, v, cls]) => (
            <div key={l} className="rounded-xl bg-white/5 ring-1 ring-white/10 px-4 py-3">
              <Icon size={16} className="text-white/40 mb-1" />
              <p className={clsx("text-2xl font-black tabular-nums", cls)}>{v}</p>
              <p className="text-[11px] uppercase tracking-wider text-white/50 font-semibold">{l}</p>
            </div>
          ))}
        </div>
        {pillarLine && <p className="relative mt-4 text-[11px] text-white/50">Pillar weights ({data.weightsSource === "AHP" ? `AHP, CR ${data.ahp?.CR}` : "set by hand"}): {pillarLine} · judged on the last {data.scoreWindowDays} days of deliveries</p>}
      </div>

      {panel === "ahp" && <AhpPanel onClose={() => setPanel(null)} onManual={() => setPanel("manual")} onApplied={() => { setPanel(null); load(); }} />}
      {panel === "manual" && data && <WeightsEditor criteria={data.criteria} weights={data.weights} onClose={() => setPanel(null)} onSaved={() => { setPanel(null); load(); }} />}

      {!loading && <AlertsPanel alerts={data?.alerts} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {TYPE_TABS.map(([k, label]) => (
            <button key={k} onClick={() => setType(k)}
              className={clsx("rounded-full px-4 py-1.5 text-sm font-semibold transition-colors", type === k ? "bg-metal-900 text-white shadow" : "bg-white text-metal-600 ring-1 ring-metal-200 hover:ring-primary-300")}>
              {label}
            </button>
          ))}
        </div>
        <div className="inline-flex flex-wrap rounded-xl bg-metal-100 p-1">
          {VIEW_TABS.map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={clsx("rounded-lg px-3 py-1 text-xs font-semibold transition-colors", view === k ? "bg-white shadow text-metal-900" : "text-metal-500 hover:text-metal-800")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-metal-200 bg-white shadow-metal"><MeltSpinner label="Scoring suppliers…" sublabel="Quality, cost, delivery and service for every supplier" /></div>
      ) : suppliers.length === 0 ? (
        <Card><p className="text-center text-metal-500 py-8">No supplier lots yet for this material. Receive a truck on Raw Material Stock to start the ranking.</p></Card>
      ) : (
        grouped.map(([label, list]) => (
          <Card key={label} title={`${label} — ${view === "overall" ? "overall ranking" : `ranked on ${PILLAR[view].label.toLowerCase()}`}`}>
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="text-left text-xs text-metal-500 border-b border-metal-200">
                    <th className="px-2 py-2 w-12">Rank</th><th className="px-2">Supplier</th><th className="px-2">Grade</th><th className="px-2">Score</th>
                    {PILLAR_KEYS.map((k) => <th key={k} className={clsx("px-2 text-center", view === k && "bg-metal-50", PILLAR[k].text)}>{PILLAR[k].label}</th>)}
                    <th className="px-2 text-center">TOPSIS</th><th className="px-2">Trend</th><th className="px-2 text-right">Effective ₹/t</th><th className="px-2 text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s, i) => {
                    const r = view === "overall" ? s.rank : i + 1;
                    return (
                      <tr key={s.supplier} onClick={() => setSelected(s)} className="border-b border-metal-100 cursor-pointer hover:bg-primary-50/50 transition-colors">
                        <td className="px-2 py-3"><span className={clsx("grid place-items-center w-7 h-7 rounded-full text-xs font-black", r === 1 ? "bg-amber-400 text-metal-950" : "bg-metal-100 text-metal-600")}>{r}</span></td>
                        <td className="px-2"><p className="font-semibold text-metal-900">{s.supplier}</p><p className="text-[11px] text-metal-500">{s.gradeLabel} · {s.lots} lots</p></td>
                        <td className="px-2"><GradeBadge grade={s.grade} /></td>
                        <td className="px-2"><ScoreBar score={s.score} /></td>
                        {PILLAR_KEYS.map((k) => <td key={k} className={clsx("px-2 text-center", view === k && "bg-metal-50")}><PillarCell p={s.pillars.find((p) => p.key === k)} /></td>)}
                        <td className="px-2 text-center text-xs tabular-nums">{s.topsis ? <span title={`closeness ${s.topsis.closeness}`}>#{s.topsis.rank}<span className="block text-[10px] text-metal-400">{s.topsis.closeness}</span></span> : "—"}</td>
                        <td className="px-2"><Sparkline trend={s.trend} direction={s.trendDirection} /></td>
                        <td className="px-2 text-right tabular-nums">
                          <b className={clsx(s.effectiveRsPerT > (s.invoiceRsPerT || 0) * 1.15 ? "text-red-700" : "text-metal-900")}>{rs(s.effectiveRsPerT)}</b>
                          <span className="block text-[10.5px] text-metal-400">invoice {rs(s.invoiceRsPerT)}</span>
                        </td>
                        <td className="px-2 text-right tabular-nums text-xs">{s.inspectPieces} pcs</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}

      {!loading && data && (
        <>
          <OrderPlanner key={orderTypes.map((t) => t[0]).join(",")} types={orderTypes} />
          <MethodsCard methods={data.methods} />
        </>
      )}

      <p className="text-xs text-metal-500">
        QCDS: Quality = acceptance rate, declaration accuracy, clean gun pieces, heat impact · Cost = effective cost of good metal, metal yield · Delivery = on-time trucks, invoice vs weighbridge weight · Service = documents with the truck.
        Pillar weights come from AHP pairwise judgements (consistency ratio below 0.10); the ranking is cross-checked with TOPSIS. Suppliers are compared within each material (ferro-alloys within each alloy), on the last {data?.scoreWindowDays ?? 120} days of deliveries.
        Grades: A ≥ 85 (10 pieces inspected), B ≥ 70 (15), C ≥ 50 (25), D below 50 (30, manager approval to release); fewer than 3 decided lots = New. Effective cost = invoice ÷ metal yield + rejection cost.
      </p>

      {selected && <SupplierDrawer s={selected} trendLabels={data?.trendLabels} windowDays={data?.scoreWindowDays} onClose={() => setSelected(null)} />}
    </div>
  );
}
