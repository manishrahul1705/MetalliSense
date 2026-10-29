const assert = require('node:assert/strict');
const { requireFresh } = require('../simulationEvidence');
const chemistry = { C: 3.5, Si: 2.2, Mn: 0.5, P: 0.02, S: 0.015 };
const row = { units: '%', created_at: new Date().toISOString(), values_json: JSON.stringify(chemistry) };
assert.equal(requireFresh(row), row);
assert.throws(() => requireFresh(null), /heat-linked/);
assert.throws(() => requireFresh({ ...row, created_at: new Date(Date.now() - 16 * 60000).toISOString() }), /15 minutes/);
assert.throws(() => requireFresh({ ...row, created_at: 'invalid' }), /heat-linked/);
assert.throws(() => requireFresh({ ...row, created_at: new Date(Date.now() + 60000).toISOString() }), /heat-linked/);
assert.throws(() => requireFresh({ ...row, units: 'ppm' }), /heat-linked/);
assert.throws(() => requireFresh({ ...row, values_json: JSON.stringify({ C: 3.5 }) }), /Missing required element/);
const physical = require('../evidenceEngine');
assert.throws(() => physical.evaluateChemistryStrict('SG-IRON', chemistry, 'SIMULATED_MEASURED'), /cannot satisfy measured/);
// Fault-injected transport unit checks are separate from the actual OPC UI run.
const service = require('../../opcuaService');
async function main() {
  assert.equal((await service.requestSpectrometerReading('SG-IRON')).success, false);
  service.isInitialized = true;
  service.server.setDeviationElements = () => {};
  service.client.writeRequestedGrade = async () => true;
  service.client.readCurrentData = async () => ({ status: 'Reading Complete', requestedGrade: 'GREY-IRON', composition: chemistry });
  assert.equal((await service.requestSpectrometerReading('SG-IRON')).success, false);
  service.client.readCurrentData = async () => ({ status: 'Reading Complete', requestedGrade: 'SG-IRON', composition: { ...chemistry, C: Infinity } });
  assert.equal((await service.requestSpectrometerReading('SG-IRON')).success, false);
  service.client.readCurrentData = async () => ({ status: 'Reading Complete', requestedGrade: 'SG-IRON', composition: chemistry });
  assert.equal((await service.requestSpectrometerReading('SG-IRON', [], 10, { composition: { ...chemistry, Si: 2.3 } })).success, false);
  service.readingInProgress = true;
  assert.equal((await service.requestSpectrometerReading('SG-IRON')).success, false);
  console.log('PASS: missing/stale/future/invalid-unit/incomplete evidence, operational simulated-evidence rejection, and fault-injected disconnected/wrong-grade/non-finite/cross-heat/busy instrument boundaries');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
