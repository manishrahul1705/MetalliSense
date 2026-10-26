import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ScanLine, Plug, PlugZap, Download, Upload, ShieldCheck } from "lucide-react";
import toast from "react-hot-toast";
import clsx from "clsx";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import {
  getGunStatus, connectGun, disconnectGun, startInspection, getGunLive, replaceArgon,
  getLots, getGunSessions, gunCsvUrl, ingestGunCsv,
} from "../services/premeltService";
import { StatusPill, Field, inputCls, kg, errMsg } from "../components/premelt/premeltUi";

const COLS = ["Cu", "Ni", "Cr", "Mo", "Sn", "Mn", "Si", "C", "P", "S"];
const FLAG_TEXT = { CU_HIGH: "Copper", STAINLESS: "Stainless", ALLOY_STEEL: "Alloy steel", SURFACE_UNRELIABLE: "Bad surface" };
const FLAG_CLS = { CU_HIGH: "bg-orange-100 text-orange-800", STAINLESS: "bg-red-100 text-red-800", ALLOY_STEEL: "bg-purple-100 text-purple-800", SURFACE_UNRELIABLE: "bg-metal-200 text-metal-700" };

const cell = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? v.toFixed(3) : v);

export default function YardInspection() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [lots, setLots] = useState([]);
  const [form, setForm] = useState({ lotId: params.get("lot") || "", device: "XRF", pieces: 15, surfacePrepared: false, inspector: "" });
  const [live, setLive] = useState(null);
  const [running, setRunning] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [csvText, setCsvText] = useState("");
  const timer = useRef(null);

  const loadStatus = useCallback(() => getGunStatus().then((r) => setStatus(r.data.data)).catch(() => setStatus(null)), []);
  const loadLots = useCallback(() => getLots().then((r) => setLots(r.data.data.filter((l) => ["STEEL_SCRAP", "CI_SCRAP"].includes(l.materialType) && l.status !== "CONSUMED"))), []);
  const loadSessions = useCallback((lotId) => lotId && getGunSessions(lotId).then((r) => setSessions(r.data.data)), []);

  useEffect(() => { loadStatus(); loadLots(); return () => clearInterval(timer.current); }, [loadStatus, loadLots]);
  useEffect(() => { if (form.lotId) loadSessions(form.lotId); else setSessions([]); }, [form.lotId, loadSessions]);

  const selected = lots.find((l) => l.lotId === form.lotId);
  // The supplier's grade sets the minimum pieces to test (A 10, B 15, C / new 25, D 30).
  const sg = selected?.supplierGrade;
  const minPieces = sg?.inspectPieces || 5;
  useEffect(() => {
    if (sg?.inspectPieces) setForm((f) => ({ ...f, pieces: sg.inspectPieces }));
  }, [form.lotId, sg?.inspectPieces]);

  const poll = () => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const r = await getGunLive();
        const l = r.data.data;
        setLive(l);
        if (l?.result || l?.error) {
          clearInterval(timer.current);
          setRunning(false);
          loadStatus(); loadLots(); loadSessions(l.lotId);
          if (l.error) toast.error(l.error);
          else {
            const d = l.result.decision;
            const msg = `${l.lotId}: ${d.status.toLowerCase().replace("_", " ")} — ${d.reason}`;
            if (d.managerApprovalRequired) toast(`${l.lotId}: gun passed, but the supplier is grade D — a manager must approve the release on Raw Material Stock.`, { icon: "🔒", duration: 7000 });
            else if (d.status === "RELEASED") toast.success(msg);
            else if (d.status === "QUARANTINED") toast.error(msg);
            else toast(msg, { icon: "⚠️" });
          }
        }
      } catch (e) {
        clearInterval(timer.current);
        setRunning(false);
        toast.error(errMsg(e));
      }
    }, 400);
  };

  const run = async () => {
    setRunning(true);
    setLive(null);
    try {
      const r = await startInspection({ ...form, inspector: form.inspector || "Yard inspector" });
      setLive(r.data.data);
      loadStatus();
      poll();
    } catch (e) {
      setRunning(false);
      toast.error(errMsg(e));
    }
  };

  const toggleConnection = async () => {
    try {
      if (status?.client?.isConnected) await disconnectGun(); else await connectGun();
      loadStatus();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const uploadCsv = async () => {
    try {
      const r = await ingestGunCsv(csvText, form.inspector || "Yard inspector");
      toast.success(`${r.data.data.sessionId}: ${r.data.data.decision.status}`);
      setCsvText("");
      loadLots(); loadSessions(r.data.data.lotId);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const connected = status?.client?.isConnected;
  const progress = live?.piecesPlanned ? Math.round((live.piecesDone / live.piecesPlanned) * 100) : 0;
  const decision = live?.result?.decision;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <ScanLine className="text-emerald-600" size={28} />
        <div>
          <h1 className="text-2xl font-bold text-metal-900">Yard Inspection — Handheld XRF / LIBS</h1>
          <p className="text-metal-500 text-sm">Screen scrap at the gate, before it reaches the furnace. Readings stream from the gun over OPC UA.</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-[22rem_1fr] gap-6 items-start">
        <div className="space-y-6">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className={clsx("w-2.5 h-2.5 rounded-full", connected ? "bg-primary-500" : status?.server?.isRunning ? "bg-amber-400" : "bg-red-500")} />
                <span className="font-semibold text-metal-900 text-sm">{connected ? "Gun connected" : status?.server?.isRunning ? "Gun ready, not connected" : "Gun simulator offline"}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={toggleConnection} disabled={!status?.server?.isRunning}>
                {connected ? <><Plug size={14} className="mr-1" />Disconnect</> : <><PlugZap size={14} className="mr-1" />Connect</>}
              </Button>
            </div>
            <p className="font-mono text-[11px] text-metal-500 mt-2 break-all">{status?.server?.endpoint || "opc.tcp://localhost:4335/MetalliSense/HandheldGun"}</p>
            <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-xs text-metal-600">
              <span>LIBS argon: <strong className="tabular-nums">{status?.server?.argonRemaining ?? "—"}</strong> carbon tests left</span>
              <button className="text-primary-700 hover:underline" onClick={async () => { await replaceArgon(); loadStatus(); toast.success("Argon canister replaced"); }}>Replace canister</button>
            </div>
          </Card>

          <Card title="Inspect a lot">
            <div className="space-y-3">
              <Field label="Scrap lot">
                <select className={inputCls} value={form.lotId} onChange={(e) => setForm({ ...form, lotId: e.target.value })}>
                  <option value="">Choose a lot…</option>
                  {lots.map((l) => <option key={l.lotId} value={l.lotId}>{l.lotId} · {l.description} · {l.status.replace("_", " ").toLowerCase()}</option>)}
                </select>
              </Field>
              {selected && (
                <div className="text-xs text-metal-600 bg-metal-50 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 mb-1"><StatusPill status={selected.status} /><span>{kg(selected.availableKg)}</span></div>
                  {selected.statusReason}
                </div>
              )}
              {sg && (
                <div className={clsx("flex items-start gap-3 rounded-lg border px-3 py-2 text-xs",
                  sg.grade === "D" ? "border-red-300 bg-red-50 text-red-900" : sg.grade === "C" || sg.grade === "NEW" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-emerald-300 bg-emerald-50 text-emerald-900")}>
                  <span className={clsx("grid place-items-center w-8 h-8 shrink-0 rounded-lg font-black text-sm",
                    sg.grade === "A" ? "bg-emerald-600 text-white" : sg.grade === "B" ? "bg-sky-600 text-white" : sg.grade === "C" ? "bg-amber-500 text-metal-950" : sg.grade === "D" ? "bg-red-700 text-white" : "bg-metal-200 text-metal-700")}>
                    {sg.grade === "NEW" ? "N" : sg.grade}
                  </span>
                  <span>
                    <b>{selected.supplier}</b> — {sg.gradeLabel}{sg.score !== null && sg.score !== undefined ? ` (score ${sg.score}${sg.rank ? `, rank ${sg.rank} of ${sg.rankOf}` : ""})` : ""}.
                    <span className="block">Supplier Scorecard sets inspection to <b>at least {sg.inspectPieces} pieces</b>.{sg.grade === "D" && " Even if the gun passes the lot, a manager must approve its release."}</span>
                  </span>
                </div>
              )}
              <Field label="Device">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[["XRF", "Seconds per piece. No carbon; low Si/P/S below detection."], ["LIBS", "Grind + argon, ~40 s per piece. Measures carbon."]].map(([d, hint]) => (
                    <button key={d} type="button" onClick={() => setForm({ ...form, device: d })}
                      className={clsx("rounded-lg border-2 px-3 py-2 text-left focus:outline-none focus:ring-2 focus:ring-primary-500", form.device === d ? "border-primary-500 bg-primary-50" : "border-metal-200")}>
                      <span className="font-bold text-sm text-metal-900">{d}</span>
                      <span className="block text-[11px] text-metal-500 leading-snug">{hint}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={`Pieces to test: ${form.pieces}`} hint={sg ? `Minimum ${minPieces} for a grade ${sg.grade === "NEW" ? "new" : sg.grade} supplier. A load holds ~400 pieces.` : "A load holds ~400 pieces. More pieces, better odds of catching a bad one."}>
                <input type="range" min={minPieces} max="40" value={Math.max(form.pieces, minPieces)} onChange={(e) => setForm({ ...form, pieces: Number(e.target.value) })} className="w-full accent-emerald-600" />
              </Field>
              {form.device === "XRF" && (
                <label className="flex items-start gap-2 text-sm text-metal-700">
                  <input type="checkbox" className="mt-1" checked={form.surfacePrepared} onChange={(e) => setForm({ ...form, surfacePrepared: e.target.checked })} />
                  <span>Surfaces cleaned or ground before shooting <span className="block text-[11px] text-metal-500">Needed for painted, oily or rusty loads.</span></span>
                </label>
              )}
              <Field label="Inspector"><input className={inputCls} value={form.inspector} onChange={(e) => setForm({ ...form, inspector: e.target.value })} placeholder="Your name" /></Field>
              <Button className="w-full" onClick={run} loading={running} disabled={!form.lotId || running}>Start inspection</Button>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title={live ? `${live.sessionId} · ${live.lotId} · ${live.device}` : "Live readings"}>
            {!live ? (
              <p className="text-sm text-metal-500 py-10 text-center">Choose a scrap lot and start an inspection. Each piece the inspector shoots appears here as the gun publishes it.</p>
            ) : (
              <>
                <div className="flex items-center justify-between text-xs text-metal-600 mb-1">
                  <span>{live.status}</span><span className="tabular-nums">{live.piecesDone}/{live.piecesPlanned} pieces</span>
                </div>
                <div className="h-2 rounded-full bg-metal-100 overflow-hidden mb-4">
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-metal-500 text-left border-b border-metal-200"><th className="py-1.5 pr-2">Piece</th>{COLS.map((c) => <th key={c} className="px-1.5 font-mono text-right">{c}</th>)}<th className="pl-3">Flags</th></tr></thead>
                    <tbody>
                      {(live.readings || []).map((r) => (
                        <tr key={r.pieceNo} className={clsx("border-b border-metal-100", r.flags.some((f) => f !== "SURFACE_UNRELIABLE") && "bg-red-50/60")}>
                          <td className="py-1.5 pr-2 font-mono">#{r.pieceNo}</td>
                          {COLS.map((c) => <td key={c} className={clsx("px-1.5 text-right tabular-nums", (c === "Cu" && r.flags.includes("CU_HIGH")) || ((c === "Cr" || c === "Ni") && r.flags.includes("STAINLESS")) ? "font-bold text-red-700" : "text-metal-700")}>{r.surfaceOk ? cell(r.values[c]) : ""}</td>)}
                          <td className="pl-3 whitespace-nowrap">{r.flags.map((f) => <span key={f} className={clsx("inline-block rounded px-1.5 py-0.5 mr-1 font-semibold", FLAG_CLS[f])}>{FLAG_TEXT[f] || f}</span>)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {live.piecesNote && <p className="mt-2 text-xs text-metal-600">{live.piecesNote}</p>}
                {live.error && <p className="mt-3 text-sm text-red-700">{live.error}</p>}
                {decision && (
                  <div className={clsx("mt-4 rounded-xl border-2 p-4",
                    decision.status === "RELEASED" ? "border-primary-400 bg-primary-50" : decision.status === "RESTRICTED" ? "border-amber-400 bg-amber-50" : decision.status === "QUARANTINED" ? "border-red-400 bg-red-50" : "border-sky-300 bg-sky-50")}>
                    <div className="flex flex-wrap items-center gap-3">
                      <StatusPill status={decision.status} />
                      <p className="font-semibold text-metal-900">{decision.reason}</p>
                    </div>
                    {decision.applied === false && <p className="text-sm text-metal-700 mt-1">{decision.note}</p>}
                    <p className="text-xs text-metal-600 mt-2">
                      Evidence: {live.result.evidence.reliable}/{live.result.evidence.piecesTested} reliable readings · worst Cu {live.result.evidence.worst?.Cu?.value ?? "—"}% · worst Cr {live.result.evidence.worst?.Cr?.value ?? "—"}%.
                      Gun readings are evidence for this decision only — they never replace the lot chemistry.
                    </p>
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => navigate("/premelt-gate")}><ShieldCheck size={14} className="mr-1" />Go to Pre-Melt Gate</Button>
                  </div>
                )}
              </>
            )}
          </Card>

          {sessions.length > 0 && (
            <Card title={`Inspection history — ${form.lotId}`}>
              {sessions.map((s) => (
                <div key={s.sessionId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-metal-100 py-2 text-sm">
                  <span className="font-mono font-semibold">{s.sessionId}</span>
                  <span className="text-metal-600">{s.device} · {s.via === "CSV_UPLOAD" ? "CSV upload" : "OPC UA"} · {s.inspector}</span>
                  <span className="text-metal-600 text-xs">{s.evidence.reliable}/{s.evidence.piecesTested} reliable, Cu {s.evidence.cuHigh}, stainless {s.evidence.stainless}, alloy {s.evidence.alloySteel}</span>
                  <StatusPill status={s.decision.status} />
                  <a href={gunCsvUrl(s.sessionId)} className="ml-auto text-xs text-primary-700 hover:underline inline-flex items-center gap-1"><Download size={12} />CSV</a>
                </div>
              ))}
            </Card>
          )}

          <Card title="Upload a real gun export">
            <p className="text-xs text-metal-500 mb-2">Real XRF/LIBS guns export CSV over USB, Wi-Fi or their cloud. Paste an export in the same column format as the simulator's CSV and it is judged the same way.</p>
            <textarea className={clsx(inputCls, "font-mono text-xs h-28")} value={csvText} onChange={(e) => setCsvText(e.target.value)}
              placeholder="timestamp,device_id,device_type,mode,lot_id,piece_no,surface_ok,test_seconds,Cu,Ni,Cr,Mo,Sn,Mn,Si,C,P,S,flags" />
            <div className="flex justify-end mt-2"><Button size="sm" variant="secondary" onClick={uploadCsv} disabled={!csvText.trim()}><Upload size={14} className="mr-1" />Ingest CSV</Button></div>
          </Card>
        </div>
      </div>
    </div>
  );
}
