import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Boxes, Truck, FlaskConical, ScanLine, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import toast from "react-hot-toast";
import clsx from "clsx";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import Modal from "../components/common/Modal";
import {
  getStockSummary, getLots, getLot, receiveLot, enterDriQa, approveDriQa, rejectDriQa,
  getAdditives, setLotStatus, getScenarios, receiveFerroalloy,
} from "../services/premeltService";
import { StatusPill, Field, inputCls, kg, errMsg, SOURCE_LABEL, MATERIAL_LABEL } from "../components/premelt/premeltUi";
import { getPurchaseRequest } from "../services/inventoryService";

const ELEMENTS = ["C", "Si", "Mn", "P", "S", "Cu", "Cr", "Ni", "Mo", "Sn"];
const DRI_DECLARED = ["feTotal", "feMetallic", "C", "P", "S", "SiO2", "Al2O3", "fines"];
const ALLOY_ELEMENTS = ["C", "Si", "Mn", "P", "S"];
const FIELD_LABEL = { feTotal: "Fe total %", feMetallic: "Fe metallic %", SiO2: "SiO₂ %", Al2O3: "Al₂O₃ %", CaO: "CaO %", MgO: "MgO %", moisture: "Moisture %", fines: "Fines (<3 mm) %" };
const label = (f) => FIELD_LABEL[f] || `${f} %`;

// ------------------------------------------------------------------ receive
function ReceiveModal({ open, onClose, onDone, scenarios, pr }) {
  const blank = { materialType: "STEEL_SCRAP", description: "", supplier: "", truckNo: "", receivedKg: "", costPerKg: "", alloyName: "FeSi-75", demoScenario: "clean", declared: {},
    promisedAt: "", invoiceKg: "", docs: { testCertificate: true, weighbridgeSlip: true, ewayBill: true }, prId: "" };
  const [f, setF] = useState(blank);
  const [saving, setSaving] = useState(false);
  // Receiving against an approved purchase request: pre-fill from it.
  useEffect(() => {
    if (!open) return;
    setF(pr ? { ...blank, materialType: pr.materialType, supplier: pr.supplier || "", receivedKg: pr.qtyKg, invoiceKg: pr.qtyKg, costPerKg: pr.estRsPerKg || "", prId: pr.prId } : blank);
  }, [open, pr]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = f.materialType === "DRI" ? DRI_DECLARED : f.materialType === "FERROALLOY" ? ALLOY_ELEMENTS : ELEMENTS;
  const isScrap = ["STEEL_SCRAP", "CI_SCRAP"].includes(f.materialType);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setDecl = (k, v) => setF((p) => ({ ...p, declared: { ...p.declared, [k]: v } }));

  const submit = async () => {
    setSaving(true);
    try {
      const res = await receiveLot({ ...f, receivedKg: Number(f.receivedKg), costPerKg: Number(f.costPerKg) || 0, invoiceKg: Number(f.invoiceKg) || undefined, promisedAt: f.promisedAt || undefined });
      const g = res.data.data.supplierGrade;
      toast.success(`${res.data.data.lotId} received${res.data.data.prId ? ` against ${res.data.data.prId}` : ""} — ${res.data.data.statusReason}${g ? `. Supplier grade ${g.grade === "NEW" ? "new" : g.grade}: inspect ${g.inspectPieces} pieces.` : ""}`, { duration: 6000 });
      onDone();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Receive truck (GRN)" size="lg">
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Material">
          <select className={inputCls} value={f.materialType} onChange={(e) => setF({ ...blank, materialType: e.target.value })}>
            {Object.entries(MATERIAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {f.materialType === "FERROALLOY" && (
          <Field label="Alloy">
            <select className={inputCls} value={f.alloyName} onChange={(e) => set("alloyName", e.target.value)}>
              {["FeSi-75", "HC FeMn", "Recarburiser"].map((a) => <option key={a}>{a}</option>)}
            </select>
          </Field>
        )}
        <Field label="Description" className={f.materialType === "FERROALLOY" ? "" : "sm:col-span-2"}>
          <input className={inputCls} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. HMS 1&2 mixed scrap" />
        </Field>
        <Field label="Supplier"><input className={inputCls} value={f.supplier} onChange={(e) => set("supplier", e.target.value)} /></Field>
        <Field label="Truck no."><input className={inputCls} value={f.truckNo} onChange={(e) => set("truckNo", e.target.value)} placeholder="TN 38 AB 1234" /></Field>
        <Field label="Weighbridge net (kg)"><input type="number" min="1" className={inputCls} value={f.receivedKg} onChange={(e) => set("receivedKg", e.target.value)} /></Field>
        <Field label="Cost (₹/kg)"><input type="number" min="0" className={inputCls} value={f.costPerKg} onChange={(e) => set("costPerKg", e.target.value)} /></Field>
        <Field label="Purchase request no." hint="Optional — closes the PR and links it to this lot"><input className={inputCls} value={f.prId} onChange={(e) => set("prId", e.target.value.toUpperCase())} placeholder="PR-0001" /></Field>
        <Field label="Invoice weight (kg)" hint="From the supplier's invoice — compared with the weighbridge"><input type="number" min="0" className={inputCls} value={f.invoiceKg} onChange={(e) => set("invoiceKg", e.target.value)} /></Field>
        <Field label="Promised delivery date" hint="From the purchase order — for on-time delivery"><input type="date" className={inputCls} value={f.promisedAt} onChange={(e) => set("promisedAt", e.target.value)} /></Field>
        <div>
          <span className="block text-xs font-semibold text-metal-700 mb-1">Documents with the truck</span>
          <div className="flex flex-col gap-1 text-xs text-metal-700 pt-1">
            {[["testCertificate", "Test certificate"], ["weighbridgeSlip", "Weighbridge slip"], ["ewayBill", "E-way bill"]].map(([k, l]) => (
              <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={!!f.docs?.[k]} onChange={(e) => set("docs", { ...f.docs, [k]: e.target.checked })} />{l}</label>
            ))}
          </div>
        </div>
        {isScrap && (
          <Field label="Simulated load condition" hint="Demo only — hidden from the inspector. The gun has to find it." className="sm:col-span-2">
            <select className={inputCls} value={f.demoScenario} onChange={(e) => set("demoScenario", e.target.value)}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
        )}
      </div>
      <p className="text-sm font-semibold text-metal-800 mt-5 mb-2">
        {f.materialType === "DRI" ? "Supplier declared analysis" : f.materialType === "PIG_IRON" || f.materialType === "FERROALLOY" ? "Certificate chemistry" : "Supplier declared chemistry"} (%)
      </p>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
        {fields.map((el) => (
          <Field key={el} label={label(el)}>
            <input type="number" step="any" min="0" className={inputCls} value={f.declared[el] ?? ""} onChange={(e) => setDecl(el, e.target.value)} />
          </Field>
        ))}
      </div>
      <p className="text-xs text-metal-500 mt-3">
        {isScrap && "Scrap stays Awaiting QA until it passes the handheld XRF/LIBS yard inspection."}
        {f.materialType === "DRI" && "Sponge iron stays Awaiting QA until the QA engineer enters the lab result and a second person approves it."}
        {["PIG_IRON", "FERROALLOY", "RETURNS"].includes(f.materialType) && "Released on receipt using the certificate chemistry."}
      </p>
      <div className="flex justify-end gap-2 mt-5">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={!f.receivedKg}>Receive lot</Button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ DRI lab
function DriQaModal({ lot, onClose, onDone }) {
  const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [f, setF] = useState({});
  const [warnings, setWarnings] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (lot) { setF({ sampleId: "", testedAt: nowLocal(), method: "Ferric chloride", analyst: "" }); setWarnings(null); }
  }, [lot]);

  const met = f.feTotal > 0 && f.feMetallic !== undefined && f.feMetallic !== "" ? (Number(f.feMetallic) / Number(f.feTotal)) * 100 : null;
  const eqMet = met !== null && f.C !== undefined && f.C !== "" ? met + 5 * Number(f.C) : null;
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setWarnings(null); };

  const submit = async (confirmWarnings = false) => {
    setSaving(true);
    try {
      await enterDriQa(lot.lotId, { ...f, confirmWarnings });
      toast.success("Lab result saved. It needs a second person to approve.");
      onDone();
      onClose();
    } catch (e) {
      if (e.response?.status === 422) setWarnings(e.response.data.warnings || []);
      else toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (!lot) return null;
  const numField = (k, req) => (
    <Field key={k} label={`${label(k)}${req ? " *" : ""}`}>
      <input type="number" step="any" min="0" className={inputCls} value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  return (
    <Modal isOpen onClose={onClose} title={`QA lab result — ${lot.lotId}`} size="lg">
      <p className="text-sm text-metal-600 mb-4">
        {lot.description} · supplier declared Fe total {lot.declared?.feTotal ?? "—"}%, Fe metallic {lot.declared?.feMetallic ?? "—"}%, P {lot.declared?.P ?? "—"}%
      </p>
      <div className="grid sm:grid-cols-4 gap-3">
        <Field label="Sample ID"><input className={inputCls} value={f.sampleId} onChange={(e) => set("sampleId", e.target.value)} placeholder="auto" /></Field>
        <Field label="Tested at"><input type="datetime-local" className={inputCls} value={f.testedAt} onChange={(e) => set("testedAt", e.target.value)} /></Field>
        <Field label="Method">
          <select className={inputCls} value={f.method} onChange={(e) => set("method", e.target.value)}>
            <option>Ferric chloride</option><option>Bromine–methanol</option><option>Other</option>
          </select>
        </Field>
        <Field label="Analyst (QA engineer) *"><input className={inputCls} value={f.analyst} onChange={(e) => set("analyst", e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        {["feTotal", "feMetallic", "C", "P", "S"].map((k) => numField(k, true))}
        {["SiO2", "Al2O3", "CaO", "MgO", "moisture", "fines"].map((k) => numField(k, false))}
      </div>
      <div className="mt-4 grid sm:grid-cols-2 gap-3">
        <div className="rounded-lg bg-metal-50 border border-metal-200 px-4 py-3">
          <p className="text-xs text-metal-500">Metallization (Fe metallic ÷ Fe total)</p>
          <p className="text-2xl font-bold text-metal-900 tabular-nums">{met === null ? "—" : `${met.toFixed(2)}%`}</p>
        </div>
        <div className="rounded-lg bg-metal-50 border border-metal-200 px-4 py-3">
          <p className="text-xs text-metal-500">Equivalent metallization (+ 5 × C)</p>
          <p className="text-2xl font-bold text-metal-900 tabular-nums">{eqMet === null ? "—" : `${eqMet.toFixed(2)}%`}</p>
        </div>
      </div>
      {warnings && (
        <div className="mt-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold mb-1">These values are unusual. Check them before saving:</p>
          <ul className="list-disc ml-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-5">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {warnings ? (
          <Button onClick={() => submit(true)} loading={saving}>Values are correct — save</Button>
        ) : (
          <Button onClick={() => submit(false)} loading={saving}>Save lab result</Button>
        )}
      </div>
    </Modal>
  );
}

function ApproveModal({ lot, onClose, onDone }) {
  const [detail, setDetail] = useState(null);
  const [approver, setApprover] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (lot) getLot(lot.lotId).then((r) => setDetail(r.data.data)); setApprover(""); setReason(""); }, [lot]);
  if (!lot) return null;
  const qa = detail?.qa.find((q) => q.status === "PENDING_APPROVAL");

  const act = async (kind) => {
    setBusy(true);
    try {
      const r = kind === "approve" ? await approveDriQa(qa.qaId, approver) : await rejectDriQa(qa.qaId, approver, reason);
      const l = r.data.data.lot;
      toast.success(`${l.lotId}: ${l.status} — ${l.statusReason}`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Approve lab result — ${lot.lotId}`} size="md">
      {!qa ? <p className="text-sm text-metal-500">No result waiting for approval.</p> : (
        <>
          <p className="text-sm text-metal-600 mb-3">{qa.qaId} v{qa.version} · entered by <strong>{qa.analyst}</strong> · {qa.method}</p>
          <div className="grid grid-cols-3 gap-2 text-sm">
            {Object.entries(qa.values).map(([k, v]) => (
              <div key={k} className="flex justify-between bg-metal-50 rounded px-3 py-1.5"><span className="text-metal-600">{label(k)}</span><strong className="tabular-nums">{v}</strong></div>
            ))}
            <div className="flex justify-between bg-primary-50 rounded px-3 py-1.5 col-span-3"><span>Metallization</span><strong>{qa.calculated.metallization}%</strong></div>
          </div>
          {qa.warningsConfirmed?.length > 0 && <p className="text-xs text-amber-700 mt-2">Analyst confirmed unusual values: {qa.warningsConfirmed.join("; ")}</p>}
          <Field label="Approver (must be a different person)" className="mt-4">
            <input className={inputCls} value={approver} onChange={(e) => setApprover(e.target.value)} />
          </Field>
          <Field label="Reason (only for rejecting)" className="mt-3">
            <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. sample taken from wet heap — re-sample" />
          </Field>
          <div className="flex justify-end gap-2 mt-5">
            <Button variant="danger" onClick={() => act("reject")} disabled={!approver || !reason || busy}>Reject</Button>
            <Button onClick={() => act("approve")} loading={busy} disabled={!approver}>Approve and apply release rules</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ ferroalloy receive modal
const ALLOY_TYPES = ['FeSi-75', 'FeSi-45', 'HC FeMn', 'LC FeMn', 'SiMn', 'FeCr', 'FeNi', 'FeMo', 'Recarburiser', 'Al notch', 'FeSiMg (nodulariser)', 'FeCaSi (inoculant)'];
const ALLOY_ELS = { 'FeSi-75': ['Si','C','Mn','P','S','Al'], 'FeSi-45': ['Si','C','Mn','P','S'], 'HC FeMn': ['Mn','C','Si','P','S'], 'LC FeMn': ['Mn','C','Si','P','S'], 'SiMn': ['Mn','Si','C','P','S'], 'FeCr': ['Cr','C','Si','P','S'], 'FeNi': ['Ni','C','Si','P','S'], 'FeMo': ['Mo','C','Si','P','S'], 'Recarburiser': ['C','S','N','H'], 'Al notch': ['Al','Si','Fe'], 'FeSiMg (nodulariser)': ['Mg','Si','Ca','Ce','Re','Al'], 'FeCaSi (inoculant)': ['Si','Ca','Al','Ba'] };

const ALLOY_CERT = { 'FeSi-75': { Si: 75, C: 0.1, Mn: 0.3, P: 0.03, S: 0.01 }, 'HC FeMn': { Mn: 70, C: 6.8, Si: 1.0, P: 0.25, S: 0.02 }, Recarburiser: { C: 98.5, S: 0.4 } };

function FerroalloyReceiveModal({ open, onClose, onDone, pr }) {
  const empty = { alloyName: 'FeSi-75', supplier: '', lotRef: '', receivedKg: '', costPerKg: '', declared: {}, prId: '' };
  const [f, setF] = useState(empty);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF(pr ? { ...empty, alloyName: pr.alloyName || 'FeSi-75', supplier: pr.supplier || '', receivedKg: pr.qtyKg, costPerKg: pr.estRsPerKg || '', prId: pr.prId, declared: { ...(ALLOY_CERT[pr.alloyName] || {}) } } : empty);
  }, [open, pr]); // eslint-disable-line react-hooks/exhaustive-deps
  const els = ALLOY_ELS[f.alloyName] || ['Si','C','Mn','P','S'];
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const setD = (k,v) => setF(p=>({...p, declared:{...p.declared,[k]:v}}));
  const submit = async () => {
    setSaving(true);
    try {
      const declared = {}; Object.entries(f.declared).forEach(([k,v])=>{ if(v!==''&&v!==null) declared[k]=Number(v); });
      const res = await receiveFerroalloy({ ...f, receivedKg: Number(f.receivedKg), costPerKg: Number(f.costPerKg)||0, declared, description: f.alloyName, receivedBy:'stores' });
      toast.success(`${res.data.data.lotId} received — ${f.alloyName} ${f.receivedKg} kg${res.data.data.prId ? ` (closes ${res.data.data.prId})` : ''}`);
      onDone(); onClose();
    } catch(e){ toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  return (
    <Modal isOpen={open} onClose={onClose} title="Receive ferroalloy / additive batch" size="lg">
      <p className="text-sm text-metal-600 mb-4">Certificate chemistry from the supplier. Released immediately on receipt.</p>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Alloy type">
          <select className={inputCls} value={f.alloyName} onChange={e=>set('alloyName',e.target.value)}>
            {ALLOY_TYPES.map(a=><option key={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Supplier"><input className={inputCls} value={f.supplier} onChange={e=>set('supplier',e.target.value)} placeholder="Supplier name"/></Field>
        <Field label="Batch / lot ref"><input className={inputCls} value={f.lotRef} onChange={e=>set('lotRef',e.target.value)} placeholder="Cert no. or lot ref"/></Field>
        <Field label="Received (kg)"><input type="number" min="1" className={inputCls} value={f.receivedKg} onChange={e=>set('receivedKg',e.target.value)}/></Field>
        <Field label="Cost (₹/kg)"><input type="number" min="0" className={inputCls} value={f.costPerKg} onChange={e=>set('costPerKg',e.target.value)}/></Field>
        <Field label="Purchase request no." hint="Optional — closes the PR"><input className={inputCls} value={f.prId} onChange={e=>set('prId',e.target.value.toUpperCase())} placeholder="PR-0001"/></Field>
      </div>
      <p className="text-sm font-semibold text-metal-800 mt-4 mb-2">Certificate chemistry (%)</p>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {els.map(el=>(
          <Field key={el} label={`${el} %`}>
            <input type="number" step="any" min="0" className={inputCls} value={f.declared[el]??''} onChange={e=>setD(el,e.target.value)}/>
          </Field>
        ))}
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={!f.receivedKg||!f.alloyName}>Receive batch</Button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ detail
function LotDetailModal({ lotId, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [decision, setDecision] = useState({ status: "RELEASED", by: "", reason: "", managerApproval: false });
  const load = useCallback(() => lotId && getLot(lotId).then((r) => setD(r.data.data)).catch((e) => toast.error(errMsg(e))), [lotId]);
  useEffect(() => { setD(null); load(); }, [load]);
  if (!lotId) return null;

  const manual = async () => {
    try {
      await setLotStatus(lotId, decision);
      toast.success("QA decision recorded");
      load();
      onChanged();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const lot = d?.lot;
  const chemKeys = lot ? Object.keys({ ...lot.declared, ...(lot.tested || {}) }) : [];
  return (
    <Modal isOpen onClose={onClose} title={lot ? `${lot.lotId} — ${lot.description}` : lotId} size="xl">
      {!d ? <p className="text-metal-500">Loading…</p> : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <StatusPill status={lot.status} />
            <span className="text-metal-700">{lot.statusReason}</span>
            {lot.restriction && <span className="text-amber-700 font-semibold">Max {lot.restriction.maxSharePct}% of any charge</span>}
          </div>
          <div className="grid sm:grid-cols-4 gap-3">
            {[
              ["Supplier", lot.supplier],
              ["Supplier grade", lot.supplierGrade ? `${lot.supplierGrade.grade === "NEW" ? "New" : lot.supplierGrade.grade}${lot.supplierGrade.score !== null && lot.supplierGrade.score !== undefined ? ` · score ${lot.supplierGrade.score}` : ""} · inspect ${lot.supplierGrade.inspectPieces} pcs` : "—"],
              ["GRN / truck", `${lot.grnNo}${lot.truckNo ? ` · ${lot.truckNo}` : ""}`],
              ["Available", `${kg(lot.availableKg)} of ${kg(lot.receivedKg)}`],
              ["Chemistry source", SOURCE_LABEL[lot.chemistrySource]],
              ["Invoice vs weighbridge", lot.invoiceKg ? `${kg(lot.invoiceKg)} vs ${kg(lot.receivedKg)} (${(((lot.invoiceKg - lot.receivedKg) / lot.invoiceKg) * 100).toFixed(1)}% short)` : "—"],
              ["Promised / received", lot.promisedAt ? `${new Date(lot.promisedAt).toLocaleDateString()} / ${new Date(lot.receivedAt).toLocaleDateString()}` : "—"],
              ["Documents", lot.docs ? [["testCertificate", "Test cert"], ["weighbridgeSlip", "WB slip"], ["ewayBill", "E-way bill"]].map(([k2, l]) => `${lot.docs[k2] ? "✓" : "✗"} ${l}`).join("  ") : "—"],
            ].map(([k, v]) => (
              <div key={k} className="bg-metal-50 rounded-lg px-3 py-2"><p className="text-xs text-metal-500">{k}</p><p className="font-semibold text-metal-900">{v}</p></div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-metal-500 text-left"><th className="py-1 pr-3">%</th>{chemKeys.map((k) => <th key={k} className="px-2 font-mono">{k}</th>)}</tr></thead>
              <tbody>
                <tr className="border-t border-metal-100"><td className="py-1.5 pr-3 text-metal-600">Declared</td>{chemKeys.map((k) => <td key={k} className="px-2 tabular-nums">{lot.declared?.[k] ?? "—"}</td>)}</tr>
                {lot.tested && <tr className="border-t border-metal-100 font-semibold"><td className="py-1.5 pr-3">Tested (lab)</td>{chemKeys.map((k) => <td key={k} className="px-2 tabular-nums">{lot.tested?.[k] ?? "—"}</td>)}</tr>}
              </tbody>
            </table>
            <p className="text-xs text-metal-500 mt-2">
              Metal it gives to a melt: yield {d.meltContribution.yieldPct}% · C {d.meltContribution.composition.C?.toFixed(3)} · Si {d.meltContribution.composition.Si?.toFixed(3)} · Mn {d.meltContribution.composition.Mn?.toFixed(3)} · P {d.meltContribution.composition.P?.toFixed(3)} · S {d.meltContribution.composition.S?.toFixed(3)}
            </p>
          </div>

          {d.qa.length > 0 && (
            <div>
              <h4 className="font-semibold text-metal-800 mb-2">QA lab history</h4>
              {d.qa.map((q) => (
                <div key={q.qaId} className="flex flex-wrap gap-x-4 border-t border-metal-100 py-1.5 text-xs">
                  <strong>{q.qaId} v{q.version}</strong><span>{q.status}</span><span>metallization {q.calculated.metallization}%</span><span>P {q.values.P}%</span>
                  <span>by {q.analyst}{q.approvedBy ? `, approved by ${q.approvedBy}` : ""}</span><span>{new Date(q.testedAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          {d.gunSessions.length > 0 && (
            <div>
              <h4 className="font-semibold text-metal-800 mb-2">Handheld gun sessions</h4>
              {d.gunSessions.map((s) => (
                <div key={s.sessionId} className="flex flex-wrap gap-x-4 border-t border-metal-100 py-1.5 text-xs">
                  <strong>{s.sessionId}</strong><span>{s.device}</span><span>{s.evidence.reliable}/{s.evidence.piecesTested} reliable</span>
                  <span>Cu-high {s.evidence.cuHigh} · stainless {s.evidence.stainless} · alloy {s.evidence.alloySteel}</span>
                  <StatusPill status={s.decision.status} /><span className="text-metal-500">{s.decision.applied === false ? s.decision.note : s.decision.reason}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <h4 className="font-semibold text-metal-800 mb-2">Stock ledger</h4>
            {d.movements.map((m) => (
              <div key={m.id} className="grid grid-cols-[6rem_6rem_1fr_10rem] gap-2 border-t border-metal-100 py-1 text-xs">
                <span className="font-semibold">{m.type}</span>
                <span className={m.kg < 0 ? "text-red-700 tabular-nums" : "text-primary-700 tabular-nums"}>{m.kg > 0 ? "+" : ""}{kg(m.kg)}</span>
                <span className="text-metal-600">{m.note} {m.heatId ? `(${m.heatId})` : ""} · {m.by}</span>
                <span className="text-metal-500">{new Date(m.at).toLocaleString()}</span>
              </div>
            ))}
          </div>

          {["QUARANTINED", "RESTRICTED", "AWAITING_QA"].includes(lot.status) && (lot.materialType !== "DRI" || lot.flags?.includes("MANAGER_APPROVAL_REQUIRED")) && (
            <div className="rounded-lg border-2 border-metal-200 p-3">
              <h4 className="font-semibold text-metal-800 mb-1">Manual QA decision</h4>
              <p className="text-xs text-metal-500 mb-3">A lot quarantined by the gun stays quarantined even if a later test passes — only a named QA decision with a reason can change it (for example, after the load was segregated).</p>
              <div className="grid sm:grid-cols-[10rem_12rem_1fr_auto] gap-2 items-end">
                <select className={inputCls} value={decision.status} onChange={(e) => setDecision({ ...decision, status: e.target.value })}>
                  <option value="RELEASED">Release</option><option value="REJECTED">Reject (return to supplier)</option>
                </select>
                <input className={inputCls} placeholder="QA name" value={decision.by} onChange={(e) => setDecision({ ...decision, by: e.target.value })} />
                <input className={inputCls} placeholder="Reason, e.g. copper pieces picked out and re-inspected" value={decision.reason} onChange={(e) => setDecision({ ...decision, reason: e.target.value })} />
                <Button size="sm" onClick={manual} disabled={!decision.by || decision.reason.length < 10 || (lot.supplierGrade?.grade === "D" && decision.status === "RELEASED" && !decision.managerApproval)}>Record decision</Button>
              </div>
              {lot.supplierGrade?.grade === "D" && (
                <label className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-2 text-xs text-red-900">
                  <input type="checkbox" className="mt-0.5" checked={decision.managerApproval} onChange={(e) => setDecision({ ...decision, managerApproval: e.target.checked })} />
                  <span><b>Manager approval.</b> {lot.supplier} is a grade D supplier (score {lot.supplierGrade.score}) on the Supplier Scorecard. Releasing its lot needs a manager — enter the manager's name above.</span>
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ page
export default function RawMaterialStock() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [pr, setPr] = useState(null);
  const [summary, setSummary] = useState(null);
  const [lots, setLots] = useState([]);
  const [additives, setAdditives] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showConsumed, setShowConsumed] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [alloyOpen, setAlloyOpen] = useState(false);
  // Arriving from Inventory Forecast with ?pr=PR-0001: open the right receive form, pre-filled.
  useEffect(() => {
    const prId = params.get("pr");
    if (!prId) return;
    getPurchaseRequest(prId).then((r) => {
      const p = r.data.data;
      if (p.status !== "APPROVED") { toast.error(`${p.prId} is ${p.status.replace("_", " ").toLowerCase()} — only approved requests can be received`); return; }
      setPr(p);
      if (p.materialType === "FERROALLOY") setAlloyOpen(true); else setReceiveOpen(true);
    }).catch((e) => toast.error(errMsg(e))).finally(() => setParams({}, { replace: true }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [qaLot, setQaLot] = useState(null);
  const [approveLot, setApproveLot] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l, a] = await Promise.all([getStockSummary(), getLots(), getAdditives()]);
      setSummary(s.data.data);
      setLots(l.data.data);
      setAdditives(a.data.data);
    } catch (e) {
      toast.error(errMsg(e, "Could not load stock"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); getScenarios().then((r) => setScenarios(r.data.data)).catch(() => {}); }, [load]);

  const rawLots = useMemo(() => lots
    .filter((l) => l.materialType !== "FERROALLOY")
    .filter((l) => !typeFilter || l.materialType === typeFilter)
    .filter((l) => !statusFilter || l.status === statusFilter)
    .filter((l) => showConsumed || l.status !== "CONSUMED"), [lots, typeFilter, statusFilter, showConsumed]);

  const action = (l) => {
    if (l.materialType === "DRI" && ["AWAITING_QA", "RELEASED", "RESTRICTED", "QUARANTINED"].includes(l.status)) {
      return <Button size="sm" variant={l.status === "AWAITING_QA" ? "primary" : "ghost"} onClick={() => setQaLot(l)}><FlaskConical size={14} className="mr-1" />{l.status === "AWAITING_QA" ? "Enter lab result" : "Re-test"}</Button>;
    }
    if (l.status === "PROVISIONAL") return <Button size="sm" onClick={() => setApproveLot(l)}><CheckCircle2 size={14} className="mr-1" />Approve</Button>;
    if (["STEEL_SCRAP", "CI_SCRAP"].includes(l.materialType) && l.status !== "CONSUMED") {
      return <Button size="sm" variant={l.status === "AWAITING_QA" ? "primary" : "ghost"} onClick={() => navigate(`/yard-inspection?lot=${l.lotId}`)}><ScanLine size={14} className="mr-1" />Inspect</Button>;
    }
    return null;
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Boxes className="text-emerald-600" size={28} />
          <div>
            <h1 className="text-2xl font-bold text-metal-900">Raw Material Stock</h1>
            <p className="text-metal-500 text-sm">Every lot from weighbridge to furnace. Nothing is charged until it is tested and released.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={load} loading={loading}><RefreshCw size={14} className="mr-1" />Refresh</Button>
          <Button variant="ghost" size="sm" onClick={() => setAlloyOpen(true)}>+ Receive alloy batch</Button>
          <Button size="sm" onClick={() => setReceiveOpen(true)}><Truck size={16} className="mr-1.5" />Receive truck</Button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {summary.byType.map((t) => (
            <button key={t.materialType} onClick={() => setTypeFilter(typeFilter === t.materialType ? "" : t.materialType)}
              className={`text-left rounded-xl border-2 px-4 py-3 bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 ${typeFilter === t.materialType ? "border-primary-500" : "border-metal-200 hover:border-metal-300"}`}>
              <p className="text-xs text-metal-500">{t.label}</p>
              <p className="text-xl font-bold text-metal-900 tabular-nums">{kg(t.usableKg)}</p>
              <p className="text-[11px] text-metal-500">usable of {kg(t.availableKg)} · {t.lots} lot{t.lots === 1 ? "" : "s"}</p>
            </button>
          ))}
        </div>
      )}

      {summary?.alerts?.length > 0 && (
        <Card>
          <div className="space-y-1.5">
            {summary.alerts.map((a, i) => (
              <button key={i} onClick={() => a.lotId && setDetailId(a.lotId)} className="flex items-center gap-2 text-sm text-left w-full hover:bg-metal-50 rounded px-2 py-1">
                <AlertTriangle size={15} className={a.level === "error" ? "text-red-600" : "text-amber-500"} />
                <span className="text-metal-800">{a.text}</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card title="Raw material lots" actions={
        <div className="flex gap-2 items-center">
          <select className="border-2 border-metal-200 rounded-lg px-2 py-1 text-xs" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {["AWAITING_QA", "PROVISIONAL", "RELEASED", "RESTRICTED", "QUARANTINED", "REJECTED", "CONSUMED"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}
          </select>
          <label className="text-xs text-metal-600 flex items-center gap-1"><input type="checkbox" checked={showConsumed} onChange={(e) => setShowConsumed(e.target.checked)} />consumed</label>
        </div>
      }>
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-metal-500 border-b border-metal-200">
                <th className="px-2 py-2">Lot</th><th className="px-2">Material</th><th className="px-2">Supplier</th>
                <th className="px-2 text-right">Available</th><th className="px-2">Status</th><th className="px-2">Chemistry from</th><th className="px-2 text-right">Next step</th>
              </tr>
            </thead>
            <tbody>
              {rawLots.map((l) => (
                <tr key={l.lotId} className="border-b border-metal-100 hover:bg-metal-50/60">
                  <td className="px-2 py-2.5">
                    <button className="font-mono font-bold text-primary-700 hover:underline" onClick={() => setDetailId(l.lotId)}>{l.lotId}</button>
                    <p className="text-xs text-metal-500 max-w-[16rem] truncate">{l.description}</p>
                  </td>
                  <td className="px-2 text-metal-700">{l.materialLabel}</td>
                  <td className="px-2 text-metal-600 text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      {l.supplierGrade && (
                        <span title={`Supplier Scorecard: ${l.supplierGrade.gradeLabel}${l.supplierGrade.score !== null && l.supplierGrade.score !== undefined ? `, score ${l.supplierGrade.score}` : ""}`}
                          className={clsx("grid place-items-center w-5 h-5 rounded text-[10px] font-black",
                            l.supplierGrade.grade === "A" ? "bg-emerald-600 text-white" : l.supplierGrade.grade === "B" ? "bg-sky-600 text-white" : l.supplierGrade.grade === "C" ? "bg-amber-500 text-metal-950" : l.supplierGrade.grade === "D" ? "bg-red-700 text-white" : "bg-metal-200 text-metal-700")}>
                          {l.supplierGrade.grade === "NEW" ? "N" : l.supplierGrade.grade}
                        </span>
                      )}
                      {l.supplier}
                    </span>
                  </td>
                  <td className="px-2 text-right tabular-nums font-semibold whitespace-nowrap">{kg(l.availableKg)}</td>
                  <td className="px-2">
                    <StatusPill status={l.status} />
                    <p className="text-[11px] text-metal-500 max-w-[18rem] mt-0.5">{l.restriction ? `max ${l.restriction.maxSharePct}% · ` : ""}{l.statusReason}</p>
                  </td>
                  <td className="px-2 text-xs text-metal-600">{SOURCE_LABEL[l.chemistrySource]}</td>
                  <td className="px-2 text-right">{action(l)}</td>
                </tr>
              ))}
              {!rawLots.length && <tr><td colSpan={7} className="text-center text-metal-500 py-8">No lots match. Receive a truck to add one.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Alloy additives">
        <p className="text-xs text-metal-500 mb-3">The Pre-Melt Gate converts the AI's recommended additions into kilograms from these lots (oldest first), and deducts them when the heat starts.</p>
        <div className="grid md:grid-cols-3 gap-4">
          {additives.map((a) => (
            <div key={a.alloyName} className={`rounded-xl border-2 p-4 ${a.lowStock ? "border-amber-300 bg-amber-50/40" : "border-metal-200"}`}>
              <div className="flex items-baseline justify-between">
                <p className="font-bold text-metal-900">{a.alloyName}</p>
                {a.lowStock && <span className="text-xs font-semibold text-amber-700">Reorder</span>}
              </div>
              <p className="text-2xl font-bold tabular-nums text-metal-900 mt-1">{kg(a.availableKg)}</p>
              <p className="text-xs text-metal-500">reorder level {kg(a.reorderLevelKg)}</p>
              <div className="mt-3 space-y-1">
                {a.lots.filter((l) => l.status !== "CONSUMED").map((l) => (
                  <button key={l.lotId} onClick={() => setDetailId(l.lotId)} className="w-full flex justify-between text-xs hover:bg-metal-50 rounded px-1 py-0.5">
                    <span className="font-mono text-primary-700">{l.lotId}</span>
                    <span className="text-metal-600">{Object.entries(l.declared).filter(([, v]) => v >= 5).map(([k, v]) => `${k} ${v}%`).join(", ")}</span>
                    <span className="tabular-nums">{kg(l.availableKg)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <ReceiveModal open={receiveOpen} onClose={() => { setReceiveOpen(false); setPr(null); }} onDone={load} scenarios={scenarios} pr={pr} />
      <FerroalloyReceiveModal open={alloyOpen} onClose={() => { setAlloyOpen(false); setPr(null); }} onDone={load} pr={pr} />
      <DriQaModal lot={qaLot} onClose={() => setQaLot(null)} onDone={load} />
      <ApproveModal lot={approveLot} onClose={() => setApproveLot(null)} onDone={load} />
      <LotDetailModal lotId={detailId} onClose={() => setDetailId(null)} onChanged={load} />
    </div>
  );
}
