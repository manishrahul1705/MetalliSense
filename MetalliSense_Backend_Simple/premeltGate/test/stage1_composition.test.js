const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const helper = require('./testHelper');
const sec = require('../security');
const { authenticate, csrfProtection } = require('../authMiddleware');
const { router } = require('../routes');
const simulation = require('../../spectrometerReadings');
const { validateComposition } = require('../compositionValidation');
const token = crypto.randomBytes(32).toString('hex');
helper.initTestDb();
sec.createServiceCredential({ serviceId: 'STAGE1-SPECTRO', serviceName: 'Isolated fixture instrument', serviceType: 'SPECTROMETER_SERVICE', apiKey: token, permittedEvidence: ['MELT_MEASURED', 'POST_CORRECTION_MEASURED'] });
sec.createUser({ userId: 'STAGE1-ADMIN', username: 'stage1-admin', displayName: 'Stage1 Admin', email: 'stage1-admin@example.invalid', password: crypto.randomBytes(32).toString('hex'), roles: ['ADMIN'] });
const heat = helper.createMeltingHeat();
const values = { C: 3.5, Si: 2.2, Mn: 0.35, P: 0.02, S: 0.01 };
const payload = { sampleId: 'STAGE1-SAMPLE', evidenceType: 'MELT_MEASURED', sourceInstrument: 'OES-01', units: '%', values };
const app = express();
app.use(express.json(), authenticate, csrfProtection);
app.use('/premelt', router);
async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/premelt/heats/${heat.heatId}/evidence`;
  async function post(body, auth = token) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await post(payload, '')).status, 401);
    const human = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user-id': 'STAGE1-ADMIN' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    assert.equal(human.status, 403, 'even an admin cannot forge service-measured chemistry');
    const accepted = await post(payload);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const id = accepted.body.data.evidenceId;
    const row = helper.getDb().prepare('SELECT * FROM evidence WHERE evidence_id = ?').get(id);
    assert.deepEqual(JSON.parse(row.values_json), values);
    assert.equal(row.units, '%');
    assert.equal(row.source_instrument, 'OES-01');
    assert.equal(row.ingested_by_service, 'STAGE1-SPECTRO');
    assert.equal(row.payload_hash, accepted.body.data.payloadHash);
    const replay = await post({ ...payload, values: Object.fromEntries(Object.entries(values).reverse()) });
    assert.equal(replay.body.data.evidenceId, id);
    const legacyHash = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
    helper.getDb().prepare('UPDATE evidence SET payload_hash = ? WHERE evidence_id = ?').run(legacyHash, id);
    assert.equal((await post(payload)).body.data.payloadHash, legacyHash, 'legacy receipts are preserved on identical replay');
    assert.equal((await post({ ...payload, units: 'ppm' })).status, 422);
    assert.equal((await post({ ...payload, sourceInstrument: 'OTHER' })).status, 409);
    assert.equal((await post({ ...payload, values: { ...values, C: 4 } })).status, 409);
    for (const invalid of [null, 'NaN', -1, 101, true]) assert.equal((await post({ ...payload, sampleId: 'bad', values: { ...values, C: invalid } })).status, 422);
    assert.throws(() => validateComposition({ ...values, C: Infinity }), { status: 422 });
    assert.equal((await post({ ...payload, evidenceType: 'MODEL_ESTIMATE' })).status, 422);
    for (const state of ['AWAITING_MEASURED_CHEMISTRY', 'AWAITING_POST_CORRECTION_MEASUREMENT', 'QUALITY_REVIEW']) {
      helper.getDb().prepare('UPDATE heats SET status = ? WHERE heat_id = ?').run(state, heat.heatId);
      assert.equal((await post({ ...payload, sampleId: `STAGE1-${state}` })).status, 200);
    }
    const saved = simulation.saveSimulation({ metalGrade: 'SG-IRON', composition: values }, heat.heatId, 'fixture-requester');
    assert.equal(saved.evidenceType, 'SIMULATED_MEASURED');
    for (const unmeasured of ['SIMULATED_MEASURED', 'MODEL_ESTIMATE', 'SUPPLIER_DECLARED', 'CHARGE_PREDICTED']) {
      assert.throws(() => require('../evidenceEngine').evaluateChemistryStrict('SG-IRON', values, unmeasured), { status: 422 });
    }
    assert.equal(simulation.list()[0].receipt.evidenceId, saved.receipt.evidenceId);
    assert.equal(helper.getDb().prepare('SELECT provenance FROM evidence WHERE evidence_id = ?').get(saved.receipt.evidenceId).provenance, 'OPC_UA_SIMULATOR');
    helper.getDb().prepare("UPDATE heats SET status = 'PLANNED' WHERE heat_id = ?").run(heat.heatId);
    assert.equal((await post({ ...payload, sampleId: 'planned' })).status, 409);
    assert.throws(() => simulation.saveSimulation({ metalGrade: 'SG-IRON', composition: values }, heat.heatId, 'requester'), { status: 409 });
    helper.closeDb();
    require('../db').initDb(helper.testDbPath);
    assert.equal(simulation.list()[0]._id, saved._id);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    const evidence = (await response.json()).data;
    assert.ok(evidence.some(e => e.evidenceId === id && e.sampleId === payload.sampleId));
    console.log('PASS: real HTTP composition acceptance, validation, provenance, receipts, lifecycle, replay, reload and simulator persistence');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); helper.closeDb(); }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
