import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import toast from "react-hot-toast";
import { Receipt, FileCheck2, Printer, X, IndianRupee, Flame, TrendingUp, RefreshCw, FileText, CheckCircle2, AlertTriangle } from "lucide-react";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import { MeltSpinner } from "../components/common/FurnaceLoader";
import { errMsg, inputCls } from "../components/premelt/premeltUi";
import { getFinishedHeats, getInvoices, getCustomers, createInvoice, getCertificate } from "../services/salesService";

const n = (v, dp = 0) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const rs = (v, dp = 0) => (v === null || v === undefined ? "—" : `₹${n(v, dp)}`);
const dt = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const gl = (g) => String(g || "").split("-").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ").replace("Sg ", "SG ");

// Print only the open document (A4), hide the app around it.
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 12mm; }
  html, body { background: #fff !important; }
  body::before, body::after { display: none !important; }
  body * { visibility: hidden !important; }
  .print-area, .print-area * { visibility: visible !important; }
  .print-root { position: absolute !important; inset: 0 !important; overflow: visible !important; height: auto !important; background: #fff !important; backdrop-filter: none !important; }
  .print-root aside { overflow: visible !important; height: auto !important; background: #fff !important; }
  .print-area { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; border: none !important; margin: 0 !important; }
  .no-print { display: none !important; }
  .page-break { break-before: page; }
}`;

function Chip({ ok, children }) {
  return <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold", ok ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800")}>{children}</span>;
}

// ─────────────────────────────────────────────── documents
function DemoBanner({ seller }) {
  if (!seller?.isDemo) return null;
  return <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900">DEMO document — company and customer details are placeholders. Set your own details before using it for real.</div>;
}

function InvoiceDoc({ inv }) {
  const s = inv.seller;
  const c = inv.customer;
  return (
    <div className="print-area mx-auto w-full max-w-[210mm] bg-white text-metal-900 shadow-xl ring-1 ring-metal-200 p-10 text-[12.5px] leading-relaxed">
      <DemoBanner seller={s} />
      <div className="flex justify-between gap-6 border-b-2 border-metal-900 pb-4">
        <div>
          <p className="text-xl font-black tracking-tight">{s.name}</p>
          <p className="text-metal-600 max-w-xs">{s.address}</p>
          <p className="text-metal-600">GSTIN: <b className="font-mono">{s.gstin}</b> · {s.phone} · {s.email}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black tracking-wide">TAX INVOICE</p>
          <p className="font-mono font-bold mt-1">{inv.invoiceId}</p>
          <p className="text-metal-600">Date: {dt(inv.issuedAt)}</p>
          <p className="text-metal-600">Due: {dt(inv.dueAt)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 py-4 border-b border-metal-200">
        <div>
          <p className="text-[10.5px] uppercase tracking-wider text-metal-500 font-bold">Bill to</p>
          <p className="font-bold">{c.name}</p>
          <p className="text-metal-600">{c.address}</p>
          <p className="text-metal-600">GSTIN: <span className="font-mono">{c.gstin}</span></p>
        </div>
        <div className="text-right">
          <p><span className="text-metal-500">Place of supply:</span> {inv.placeOfSupply}</p>
          <p><span className="text-metal-500">Customer PO:</span> {inv.poNumber || "—"}</p>
          <p><span className="text-metal-500">Heat:</span> <b className="font-mono">{inv.heatId}</b></p>
          <p><span className="text-metal-500">Test certificate:</span> <span className="font-mono">{inv.certificateNo}</span></p>
        </div>
      </div>

      <table className="w-full mt-4">
        <thead><tr className="border-y-2 border-metal-900 text-left text-[11px] uppercase tracking-wider">
          <th className="py-2 w-8">#</th><th>Description</th><th className="px-3">HSN</th><th className="px-3 text-right whitespace-nowrap">Qty</th><th className="px-3 text-right whitespace-nowrap">Rate (₹/kg)</th><th className="text-right whitespace-nowrap">Amount (₹)</th>
        </tr></thead>
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={i} className="border-b border-metal-200 align-top">
              <td className="py-3">{i + 1}</td>
              <td className="py-3 pr-4">{l.description}</td>
              <td className="py-3 px-3 font-mono">{l.hsn}</td>
              <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap">{n(l.qtyKg)} {l.unit}</td>
              <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap">{n(l.rate, 2)}</td>
              <td className="py-3 text-right tabular-nums whitespace-nowrap">{n(l.amount, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-end mt-3">
        <table className="w-72 tabular-nums">
          <tbody>
            <tr><td className="py-1 text-metal-600">Taxable value</td><td className="text-right">{n(inv.taxable, 2)}</td></tr>
            {inv.intraState ? (
              <>
                <tr><td className="py-1 text-metal-600">CGST {inv.gstPct / 2}%</td><td className="text-right">{n(inv.cgst, 2)}</td></tr>
                <tr><td className="py-1 text-metal-600">SGST {inv.gstPct / 2}%</td><td className="text-right">{n(inv.sgst, 2)}</td></tr>
              </>
            ) : (
              <tr><td className="py-1 text-metal-600">IGST {inv.gstPct}%</td><td className="text-right">{n(inv.igst, 2)}</td></tr>
            )}
            <tr><td className="py-1 text-metal-600">Round off</td><td className="text-right">{n(inv.roundOff, 2)}</td></tr>
            <tr className="border-t-2 border-metal-900 font-black text-[14px]"><td className="py-2">Total</td><td className="text-right">₹{n(inv.total)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-right italic text-metal-700">{inv.totalInWords}</p>

      <div className="grid grid-cols-2 gap-6 mt-8 pt-4 border-t border-metal-200">
        <div className="text-[11.5px] text-metal-600">
          <p className="font-bold text-metal-800">Terms</p>
          <p>Payment: {inv.paymentTerms}. Bank: {s.bank}.</p>
          <p>Castings supplied from heat {inv.heatId}; chemistry and properties as per test certificate {inv.certificateNo}.</p>
        </div>
        <div className="text-right">
          <p className="text-metal-600">For {s.name}</p>
          <div className="h-12" />
          <p className="border-t border-metal-400 inline-block pt-1 px-6 text-metal-700">Authorised signatory</p>
          <p className="text-[11px] text-metal-500 mt-1">Prepared by {inv.createdBy}</p>
        </div>
      </div>
    </div>
  );
}

function CertificateDoc({ c }) {
  const passAll = c.result === "PASS";
  return (
    <div className="print-area mx-auto w-full max-w-[210mm] bg-white text-metal-900 shadow-xl ring-1 ring-metal-200 p-10 text-[12.5px] leading-relaxed">
      <DemoBanner seller={c.seller} />
      <div className="flex justify-between gap-6 border-b-2 border-metal-900 pb-4">
        <div>
          <p className="text-xl font-black tracking-tight">{c.seller.name}</p>
          <p className="text-metal-600 max-w-xs">{c.seller.address}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black tracking-wide">TEST CERTIFICATE</p>
          <p className="text-metal-600">{c.type}</p>
          <p className="font-mono font-bold mt-1">{c.certificateNo}</p>
          <p className="text-metal-600">Issued: {dt(c.issuedAt)}</p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 py-4 border-b border-metal-200">
        {[["Heat no.", c.heatId], ["Grade ordered", c.gradeLabel], ["Castings", `${n(c.castingsKg)} kg`], ["Customer", c.customer?.name || "—"]].map(([k, v]) => (
          <div key={k}><p className="text-[10.5px] uppercase tracking-wider text-metal-500 font-bold">{k}</p><p className="font-bold">{v}</p></div>
        ))}
      </div>

      <div className={clsx("mt-4 rounded-lg border-2 px-4 py-2.5 font-bold", passAll ? "border-emerald-500 bg-emerald-50 text-emerald-900" : "border-amber-500 bg-amber-50 text-amber-900")}>
        {passAll ? `Result: PASS — conforms to ${c.gradeLabel}` : `Result: DOWNGRADED — ${c.downgradeNote}`}
      </div>

      <p className="mt-5 font-bold uppercase tracking-wider text-[11px]">1. Chemical composition (%)</p>
      <table className="w-full mt-1 tabular-nums">
        <thead><tr className="border-y border-metal-900 text-left text-[11px] uppercase"><th className="py-1.5">Element</th><th className="text-right">Min</th><th className="text-right">Max</th><th className="text-right">Actual</th><th className="text-right">Result</th></tr></thead>
        <tbody>
          {c.chemistry.rows.map((r) => (
            <tr key={r.element} className="border-b border-metal-100">
              <td className="py-1.5 font-mono font-bold">{r.element}{r.residual && <span className="font-sans font-normal text-metal-400"> (residual)</span>}</td>
              <td className="text-right">{r.min ?? "—"}</td><td className="text-right">{r.max ?? "—"}</td>
              <td className="text-right font-bold">{r.value}</td>
              <td className={clsx("text-right font-bold", r.pass ? "text-emerald-700" : "text-red-700")}>{r.pass ? "OK" : "OUT"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-5 font-bold uppercase tracking-wider text-[11px]">2. Mechanical properties{c.mechanical.standard ? ` — ${c.mechanical.standard}` : ""}</p>
      <table className="w-full mt-1 tabular-nums">
        <thead><tr className="border-y border-metal-900 text-left text-[11px] uppercase"><th className="py-1.5">Property</th><th className="text-right">Min</th><th className="text-right">Max</th><th className="text-right">Value</th><th className="text-right">Result</th></tr></thead>
        <tbody>
          {c.mechanical.rows.map((r) => (
            <tr key={r.property} className="border-b border-metal-100">
              <td className="py-1.5">{r.property} ({r.unit})</td>
              <td className="text-right">{r.min ?? "—"}</td><td className="text-right">{r.max ?? "—"}</td>
              <td className="text-right font-bold">{r.value}</td>
              <td className={clsx("text-right font-bold", r.pass ? "text-emerald-700" : "text-red-700")}>{r.pass ? "OK" : "OUT"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-metal-500 mt-1">{c.mechanical.basis}.</p>

      <p className="mt-5 font-bold uppercase tracking-wider text-[11px]">3. Raw material traceability</p>
      <table className="w-full mt-1 tabular-nums">
        <thead><tr className="border-y border-metal-900 text-left text-[11px] uppercase"><th className="py-1.5">Lot</th><th>Material</th><th>Supplier</th><th className="text-right">kg</th></tr></thead>
        <tbody>
          {c.traceability.map((t) => (
            <tr key={t.lotId} className="border-b border-metal-100">
              <td className="py-1.5 font-mono font-bold">{t.lotId}</td><td>{String(t.material || "").replace("_", " ").toLowerCase()}{t.status === "Addition" ? " (addition)" : ""}</td><td>{t.supplier}</td><td className="text-right">{n(t.kg, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-metal-600 mt-2">Charge cleared by the Pre-Melt Gate {c.gate.gateId ? `(${c.gate.gateId}, ${c.gate.decision}${c.gate.mode === "ENGINEER_OVERRIDE" ? ", engineer override" : ""})` : ""} before melting.</p>

      <div className="grid grid-cols-2 gap-6 mt-8 pt-4 border-t border-metal-200">
        <div className="text-[11.5px] text-metal-600">
          <p>We certify that the castings above were made from heat {c.heatId} and tested as stated.</p>
          {c.invoiceId && <p>Invoice: <span className="font-mono">{c.invoiceId}</span></p>}
        </div>
        <div className="text-right">
          <p className="text-metal-600">Tap approved by</p>
          <p className="font-bold">{c.approvedBy}</p>
          <div className="h-8" />
          <p className="border-t border-metal-400 inline-block pt-1 px-6 text-metal-700">Quality / Metallurgy</p>
        </div>
      </div>
    </div>
  );
}

function DocViewer({ heatId, invoice, initialTab, onClose }) {
  const [tab, setTab] = useState(initialTab || (invoice ? "invoice" : "certificate"));
  const [cert, setCert] = useState(null);
  useEffect(() => { getCertificate(heatId).then((r) => setCert(r.data.data)).catch((e) => toast.error(errMsg(e))); }, [heatId]);
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, [onClose]);
  return createPortal(
    <div className="print-root fixed inset-0 z-[100] bg-metal-950/60 backdrop-blur-[2px]" onClick={onClose}>
      <style>{PRINT_CSS}</style>
      <aside role="dialog" aria-modal="true" aria-label="Document" className="h-full w-full overflow-y-auto bg-metal-100" onClick={(e) => e.stopPropagation()}>
        <div className="no-print sticky top-0 z-10 bg-metal-950 text-white shadow-lg">
          <div className="max-w-5xl mx-auto px-6 py-3 flex flex-wrap items-center gap-3">
            <p className="font-bold mr-auto">Heat {heatId}</p>
            <div className="inline-flex rounded-lg bg-white/10 p-1">
              {invoice && <button onClick={() => setTab("invoice")} className={clsx("rounded-md px-3 py-1 text-xs font-semibold", tab === "invoice" ? "bg-white text-metal-900" : "text-white/70")}>Tax invoice</button>}
              <button onClick={() => setTab("certificate")} className={clsx("rounded-md px-3 py-1 text-xs font-semibold", tab === "certificate" ? "bg-white text-metal-900" : "text-white/70")}>Test certificate</button>
            </div>
            <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-bold hover:bg-primary-500"><Printer size={14} />Print / Save as PDF</button>
            <button onClick={onClose} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white/80 ring-1 ring-white/20 hover:bg-white/10"><X size={14} />Close</button>
          </div>
        </div>
        <div className="py-8 px-4">
          {tab === "invoice" && invoice ? <InvoiceDoc inv={invoice} /> : cert ? <CertificateDoc c={cert} /> : <MeltSpinner label="Preparing the certificate…" />}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────── create invoice
function InvoiceDialog({ heat, customers, onClose, onCreated }) {
  const [f, setF] = useState({ customerId: customers[0]?.id || "", qtyKg: heat.tap.castingsKg, ratePerKg: heat.tap.sellingRsPerKg, poNumber: "", createdBy: "" });
  const [busy, setBusy] = useState(false);
  const cust = customers.find((c) => c.id === f.customerId);
  const taxable = (Number(f.qtyKg) || 0) * (Number(f.ratePerKg) || 0);
  const intra = cust && cust.stateCode === "33";
  const gst = taxable * 0.18;
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await createInvoice({ heatId: heat.heatId, ...f, qtyKg: Number(f.qtyKg), ratePerKg: Number(f.ratePerKg) });
      toast.success(`${r.data.data.invoiceId} issued`);
      onCreated(r.data.data);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return createPortal(
    <div className="fixed inset-0 z-[110] grid place-items-center bg-metal-950/50 backdrop-blur-[2px] p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Create invoice" className="w-full max-w-xl rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-metal-100">
          <h3 className="font-bold text-metal-900">Invoice heat {heat.heatId} · {gl(heat.tap.soldGrade)} castings</h3>
          <button onClick={onClose} className="p-1 text-metal-400 hover:text-metal-700" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          {heat.tap.result === "DOWNGRADED" && <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">{heat.tap.downgradeNote}. Priced at the lower grade.</p>}
          <label className="block text-xs font-semibold text-metal-700">Customer
            <select className={clsx(inputCls, "mt-1")} value={f.customerId} onChange={(e) => set("customerId", e.target.value)}>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.state}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="text-xs font-semibold text-metal-700">Quantity (kg)
              <input type="number" className={clsx(inputCls, "mt-1")} value={f.qtyKg} onChange={(e) => set("qtyKg", e.target.value)} />
              <span className="block text-[11px] font-normal text-metal-500 mt-1">{n(heat.tap.castingsKg)} kg castings from this heat</span>
            </label>
            <label className="text-xs font-semibold text-metal-700">Rate (₹/kg)
              <input type="number" step="0.01" className={clsx(inputCls, "mt-1")} value={f.ratePerKg} onChange={(e) => set("ratePerKg", e.target.value)} />
              <span className="block text-[11px] font-normal text-metal-500 mt-1">List price ₹{n(heat.tap.sellingRsPerKg, 2)}/kg</span>
            </label>
            <label className="text-xs font-semibold text-metal-700">Customer PO no.
              <input className={clsx(inputCls, "mt-1")} value={f.poNumber} onChange={(e) => set("poNumber", e.target.value)} placeholder="Optional" />
            </label>
          </div>
          <label className="block text-xs font-semibold text-metal-700">Prepared by
            <input className={clsx(inputCls, "mt-1")} value={f.createdBy} onChange={(e) => set("createdBy", e.target.value)} placeholder="Your name" />
          </label>
          <div className="rounded-xl bg-metal-50 border border-metal-200 px-4 py-3 text-sm tabular-nums">
            <div className="flex justify-between"><span className="text-metal-600">Taxable value</span><span>{rs(taxable, 2)}</span></div>
            <div className="flex justify-between"><span className="text-metal-600">{intra ? "CGST 9% + SGST 9%" : "IGST 18%"} <span className="text-[11px]">({intra ? "same state" : "other state"})</span></span><span>{rs(gst, 2)}</span></div>
            <div className="flex justify-between font-black text-base border-t border-metal-200 mt-1 pt-1"><span>Total</span><span>{rs(Math.round(taxable + gst))}</span></div>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} loading={busy} disabled={!f.createdBy.trim() || !f.customerId}><Receipt size={14} className="mr-1" />Issue invoice</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────── page
export default function SalesInvoices() {
  const [params, setParams] = useSearchParams();
  const [heats, setHeats] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [invFor, setInvFor] = useState(null);
  const [view, setView] = useState(null); // { heatId, invoice, tab }

  const load = useCallback(async () => {
    try {
      const [h, i, c] = await Promise.all([getFinishedHeats(), getInvoices(), getCustomers()]);
      setHeats(h.data.data); setInvoices(i.data.data); setCustomers(c.data.data);
      return h.data.data;
    } catch (e) { toast.error(errMsg(e, "Could not load sales")); return []; } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    load().then((hs) => {
      const hid = params.get("heat");
      if (!hid) return;
      const h = hs.find((x) => x.heatId === hid);
      if (h && !h.invoiceId) setInvFor(h);
      else if (!h) toast.error(`${hid} is not recorded as finished yet — open Mechanical Properties and approve the tap (or click "Record finished heat")`, { id: `not-finished-${hid}`, duration: 7000 });
      setParams({}, { replace: true });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const kpi = useMemo(() => {
    const withMargin = heats.filter((h) => h.margin?.marginPct !== null && h.margin?.marginPct !== undefined);
    return {
      ready: heats.filter((h) => !h.invoiceId).length,
      issued: invoices.length,
      revenue: invoices.reduce((s, i) => s + i.total, 0),
      avgMargin: withMargin.length ? withMargin.reduce((s, h) => s + h.margin.marginPct, 0) / withMargin.length : null,
    };
  }, [heats, invoices]);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-metal-950 via-metal-900 to-primary-950 text-white p-6 md:p-8 shadow-metal-xl">
        <div className="pointer-events-none absolute -top-24 -right-16 w-80 h-80 rounded-full bg-primary-500/20 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="grid place-items-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-400 to-primary-700 shadow-lg ring-1 ring-white/20"><Receipt size={28} /></span>
            <div>
              <p className="text-[11px] uppercase tracking-[0.25em] text-primary-300 font-semibold">After the melt · dispatch</p>
              <h1 className="text-3xl font-black tracking-tight">Sales &amp; Dispatch</h1>
              <p className="text-white/60 text-sm max-w-2xl mt-1">Heats finished at Approve Tap become castings to sell: issue the tax invoice and the test certificate — chemistry, mechanical properties and the raw material lots behind every heat.</p>
            </div>
          </div>
          <button onClick={() => { setLoading(true); load(); }} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white/80 ring-1 ring-white/15 hover:bg-white/10"><RefreshCw size={13} />Refresh</button>
        </div>
        <div className="relative grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          {[
            [Flame, "Heats ready to invoice", kpi.ready, "text-orange-300"],
            [FileText, "Invoices issued", kpi.issued, "text-white"],
            [IndianRupee, "Invoiced (incl. GST)", rs(kpi.revenue), "text-emerald-300"],
            [TrendingUp, "Average metal margin", kpi.avgMargin === null ? "—" : `${n(kpi.avgMargin, 1)}%`, "text-sky-300"],
          ].map(([Icon, l, v, cls]) => (
            <div key={l} className="rounded-xl bg-white/5 ring-1 ring-white/10 px-4 py-3">
              <Icon size={16} className="text-white/40 mb-1" />
              <p className={clsx("text-2xl font-black tabular-nums", cls)}>{v}</p>
              <p className="text-[11px] uppercase tracking-wider text-white/50 font-semibold">{l}</p>
            </div>
          ))}
        </div>
      </div>

      {loading && !heats.length ? (
        <div className="rounded-2xl border border-metal-200 bg-white"><MeltSpinner label="Loading finished heats…" /></div>
      ) : (
        <>
          <Card title="Finished heats">
            {heats.length === 0 ? (
              <p className="text-sm text-metal-500 py-6 text-center">No finished heats yet. A heat is finished when the engineer clicks <b>Approve Tap</b> on Mechanical Properties.</p>
            ) : (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm min-w-[980px]">
                  <thead><tr className="text-left text-xs text-metal-500 border-b border-metal-200">
                    <th className="px-2 py-2">Heat</th><th className="px-2">Grade</th><th className="px-2">Test result</th><th className="px-2 text-right">Castings</th><th className="px-2 text-right">Returns</th>
                    <th className="px-2 text-right">Value</th><th className="px-2 text-right">Metal margin</th><th className="px-2">Tap approved</th><th className="px-2 text-right">Documents</th>
                  </tr></thead>
                  <tbody>
                    {heats.map((h) => (
                      <tr key={h.heatId} className="border-b border-metal-100">
                        <td className="px-2 py-3 font-mono font-bold">{h.heatId}</td>
                        <td className="px-2">{h.gradeLabel}{h.tap.result === "DOWNGRADED" && <span className="block text-[11px] text-amber-700">sold as {gl(h.tap.soldGrade)}</span>}</td>
                        <td className="px-2">{h.tap.result === "PASS" ? <Chip ok><CheckCircle2 size={11} className="mr-1" />Pass</Chip> : <Chip><AlertTriangle size={11} className="mr-1" />Downgraded</Chip>}</td>
                        <td className="px-2 text-right tabular-nums">{n(h.tap.castingsKg)} kg</td>
                        <td className="px-2 text-right tabular-nums text-metal-500">{n(h.tap.returnsKg)} kg<span className="block text-[10.5px] font-mono">{h.tap.returnsLotId}</span></td>
                        <td className="px-2 text-right tabular-nums">{rs(h.margin?.revenueRs)}<span className="block text-[10.5px] text-metal-400">₹{n(h.tap.sellingRsPerKg, 2)}/kg</span></td>
                        <td className="px-2 text-right tabular-nums" title={h.margin?.note}>
                          <b className={h.margin?.marginRs >= 0 ? "text-emerald-700" : "text-red-700"}>{rs(h.margin?.marginRs)}</b>
                          <span className="block text-[10.5px] text-metal-400">{h.margin?.marginPct === null ? "" : `${n(h.margin.marginPct, 1)}% · metal, alloys, energy`}</span>
                        </td>
                        <td className="px-2 text-xs text-metal-600">{h.tap.approvedBy}<span className="block text-metal-400">{dt(h.tap.at)}</span></td>
                        <td className="px-2 text-right whitespace-nowrap">
                          <span className="inline-flex gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => setView({ heatId: h.heatId, invoice: invoices.find((i) => i.heatId === h.heatId) || null, tab: "certificate" })}><FileCheck2 size={13} className="mr-1" />Certificate</Button>
                            {h.invoiceId
                              ? <Button size="sm" variant="outline" onClick={() => setView({ heatId: h.heatId, invoice: invoices.find((i) => i.invoiceId === h.invoiceId), tab: "invoice" })}><Receipt size={13} className="mr-1" />View invoice</Button>
                              : <Button size="sm" onClick={() => setInvFor(h)}><Receipt size={13} className="mr-1" />Create invoice</Button>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Invoices">
            {invoices.length === 0 ? <p className="text-sm text-metal-500 py-6 text-center">No invoices yet.</p> : (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm min-w-[860px]">
                  <thead><tr className="text-left text-xs text-metal-500 border-b border-metal-200">
                    <th className="px-2 py-2">Invoice</th><th className="px-2">Date</th><th className="px-2">Customer</th><th className="px-2">Heat</th><th className="px-2 text-right">Quantity</th><th className="px-2 text-right">Total (incl. GST)</th><th className="px-2 text-right">Action</th>
                  </tr></thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.invoiceId} className="border-b border-metal-100">
                        <td className="px-2 py-3 font-mono font-bold">{i.invoiceId}</td>
                        <td className="px-2">{dt(i.issuedAt)}</td>
                        <td className="px-2">{i.customer?.name || i.customer || "Customer"}<span className="block text-[11px] text-metal-400">{i.intraState ? "CGST + SGST" : "IGST"} · {i.customer?.state || ""}</span></td>
                        <td className="px-2 font-mono">{i.heatId}</td>
                        <td className="px-2 text-right tabular-nums">{n(i.lines[0].qtyKg)} kg</td>
                        <td className="px-2 text-right tabular-nums font-bold">{rs(i.total)}</td>
                        <td className="px-2 text-right"><Button size="sm" variant="outline" onClick={() => setView({ heatId: i.heatId, invoice: i, tab: "invoice" })}><Printer size={13} className="mr-1" />View / print</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="text-xs text-metal-500">Castings = {`liquid metal × casting yield`} (70%); runners, risers and rejects (25%) go back to Raw Material Stock as foundry returns with the heat's chemistry. Heats that fail chemistry or mechanical properties are sold at the next lower grade. Metal margin = castings at list price − charge materials − alloy additions − melt energy + returns credit (moulding, labour and overheads not included).</p>
        </>
      )}

      {invFor && <InvoiceDialog heat={invFor} customers={customers} onClose={() => setInvFor(null)} onCreated={(inv) => { setInvFor(null); load(); setView({ heatId: inv.heatId, invoice: inv, tab: "invoice" }); }} />}
      {view && <DocViewer key={`${view.heatId}-${view.tab}`} heatId={view.heatId} invoice={view.invoice} initialTab={view.tab} onClose={() => setView(null)} />}
    </div>
  );
}
