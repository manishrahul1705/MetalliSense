import React, { useState } from 'react';
import api from '../../services/api';
import Card from '../common/Card';
import Button from '../common/Button';
import toast from 'react-hot-toast';

// Uses the normal heat, evidence, correction, inventory and release interfaces.
export default function SimulationBatch({ heatId }) {
  const [heat, setHeat] = useState(null);
  const [evidence, setEvidence] = useState([]);
  const [lots, setLots] = useState([]);
  const [candidate, setCandidate] = useState(null);
  const [lotId, setLotId] = useState('');
  const [kg, setKg] = useState('1');
  const [lab, setLab] = useState({ uts_mpa: '', ys_mpa: '', elongation_pct: '', hardness_hb: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async fn => {
    setBusy(true);
    try { await fn(); } catch (e) { const text = e.response?.data?.message || e.message; setMessage(text); toast.error(text); }
    finally { setBusy(false); }
  };
  const load = async () => {
    const [h, ev, stock, candidates] = await Promise.all([
      api.get(`/premelt/heats/${encodeURIComponent(heatId)}`),
      api.get(`/premelt/heats/${encodeURIComponent(heatId)}/evidence`),
      api.get('/premelt/lots', { params: { type: 'FERROALLOY' } }),
      api.get(`/premelt/heats/${encodeURIComponent(heatId)}/corrections`)
    ]);
    setHeat(h.data.data); setEvidence(ev.data.data); setLots(stock.data.data);
    setCandidate(candidates.data.data[0] || null);
    return h.data.data;
  };
  const evaluate = async () => {
    const lot = lots.find(l => l.lotId === lotId);
    const r = await api.post('/premelt/corrections/evaluate', { heatId, targetGrade: heat.grade,
      additions: [{ lotId, alloyName: lot?.alloyName, kg: Number(kg) }] });
    if (!r.data.data.feasible) throw new Error(`Infeasible correction: ${JSON.stringify(r.data.data.outOfSpecElements || r.data.data.reason)}`);
    setCandidate(r.data.data); setMessage('Feasible candidate saved. An independent reviewer must approve it.');
  };
  const approve = async () => {
    await api.post('/premelt/corrections/approve', { ...candidate, heatId });
    await load(); setMessage('Independent correction approval recorded.');
  };
  const deduct = async () => {
    await api.post('/premelt/additives/deduct', { heatId, lines: candidate.additions,
      candidateId: candidate.candidateId, candidateHash: candidate.candidateHash },
    { headers: { 'Idempotency-Key': `simulation-${candidate.candidateId}` } });
    await load(); setMessage('Approved stock deducted. Request a subsequent OPC sample before final QA.');
  };
  const finalQa = async () => {
    await api.post(`/premelt/heats/${encodeURIComponent(heatId)}/evidence`, {
      evidenceType: 'SIMULATED_LAB', sampleId: `SIM-LAB-${crypto.randomUUID()}`,
      units: 'MPa, %, HB', sourceInstrument: 'SIMULATED_LAB_QA',
      values: Object.fromEntries(Object.entries(lab).map(([k, v]) => [k, Number(v)]))
    });
    await load(); setMessage('Simulated final QA recorded. These are fixture results, not physical tests.');
  };
  const release = async () => {
    const h = await load();
    await api.post(`/sales/heats/${encodeURIComponent(heatId)}/complete`, { version: h.version });
    await load(); setMessage('Simulation batch released. Simulation documents are available in Sales & Invoices.');
  };
  return <Card title="Simulation batch lifecycle">
    <p className="border-2 border-amber-600 p-3 font-bold">SIMULATION — NOT FOR PRODUCTION OR COMMERCIAL USE</p>
    <p className="my-3 text-sm">Use the Heat ID above. Initial samples use saved charge chemistry; corrected samples use consumed additions and the documented recovery model. ML validity is unverified.</p>
    <Button disabled={!heatId || busy} onClick={() => run(load)}>Load simulation batch</Button>
    {heat && <div className="space-y-3 mt-4">
      <p>Batch {heat.heatId}: {heat.status} | {heat.executionContext} | version {heat.version}</p>
      <p>Latest chemistry receipt: {evidence.filter(e => e.evidenceType === 'SIMULATED_MEASURED').at(-1)?.evidenceId || 'Missing'}</p>
      <label className="block">Correction stock<select aria-label="Correction stock" className="border p-2 ml-2" value={lotId} onChange={e => setLotId(e.target.value)}><option value="">Choose additive</option>{lots.map(l => <option key={l.lotId} value={l.lotId}>{l.lotId} {l.alloyName} ({l.availableKg} kg)</option>)}</select></label>
      <label className="block">Correction kg<input aria-label="Correction kg" type="number" step="0.001" className="border p-2 ml-2" value={kg} onChange={e => setKg(e.target.value)} /></label>
      <Button disabled={busy || !lotId} onClick={() => run(evaluate)}>Evaluate and save correction</Button>
      {candidate && <div className="border p-3 space-y-2">
        <p>Candidate: {candidate.candidateId}</p><p>Hash: {candidate.candidateHash}</p>
        <p>Evidence: {candidate.evidenceVersion} | heat version: {candidate.expectedHeatVersion}</p>
        <p>Quantities: {candidate.additions.map(a => `${a.lotId}: ${a.kg} kg`).join(', ')}</p>
        <p>Approval: {candidate.approval ? `${candidate.approval.checker_id} — ${candidate.approval.is_consumed ? 'CONSUMED' : 'APPROVED'}` : 'PENDING'}</p>
        <Button disabled={busy || !!candidate.approval} onClick={() => run(approve)}>Independently approve correction</Button>
        <Button disabled={busy || !candidate.approval || !!candidate.approval.is_consumed} onClick={() => run(deduct)}>Deduct approved simulation stock</Button>
      </div>}
      <fieldset className="border p-3"><legend>Simulated final laboratory QA</legend>
        <p className="text-sm">Enter documented simulation fixture values. This does not record a physical laboratory test.</p>
        {Object.entries(lab).map(([key, value]) => <label key={key} className="block my-2">{key}<input aria-label={key} className="border p-2 ml-2" type="number" value={value} onChange={e => setLab({ ...lab, [key]: e.target.value })} /></label>)}
        <Button disabled={busy} onClick={() => run(finalQa)}>Save simulated final QA</Button>
      </fieldset>
      <Button disabled={busy || heat.status === 'RELEASED'} onClick={() => run(release)}>Release simulation batch</Button>
      <a className="block underline" href="/sales">Open Sales & Invoices</a>
    </div>}
    {message && <p role="status" className="mt-3 font-semibold">{message}</p>}
  </Card>;
}
