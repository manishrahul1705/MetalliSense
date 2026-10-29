const crypto = require('node:crypto');
const { getDb, withTransaction } = require('./premeltGate/db');
const { validateComposition, ELIGIBLE_EVIDENCE_STATES } = require('./premeltGate/compositionValidation');
const error = (status, message) => Object.assign(new Error(message), { status });

function eligibleHeat(heatId) {
  if (!heatId) return null;
  const heat = getDb().prepare('SELECT * FROM heats WHERE heat_id = ?').get(heatId);
  if (!heat) throw error(404, 'Heat not found');
  if (!ELIGIBLE_EVIDENCE_STATES.has(heat.status)) throw error(409, 'Composition requires an active heat awaiting measurement or quality review');
  return heat;
}

function saveSimulation(reading, heatId, actor) {
  return withTransaction((db) => {
    const heat = eligibleHeat(heatId);
    validateComposition(reading.composition);
    if (heat && heat.grade !== reading.metalGrade) throw error(409, 'Reading grade must match the heat');
    const id = `SIM-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const saved = { ...reading, _id: id, sampleId: id, heatId: heatId || null,
      executionContext: require('./premeltGate/simulationContext').context(db),
      evidenceType: 'SIMULATED_MEASURED', provenance: 'OPC_UA_SIMULATOR',
      sourceInstrument: 'SIMULATED_OES', units: '%', requestedBy: actor, createdAt: now };
    if (heat) {
      saved.receipt = { evidenceId: id, heatId, sampleId: id, status: 'RECORDED', evidenceType: saved.evidenceType };
      db.prepare(`INSERT INTO evidence (evidence_id, heat_id, evidence_type, values_json,
        source_instrument, units, provenance, spec_version, actor, created_at, is_valid, sample_id, payload_hash, ingested_by_service)
        VALUES (?, ?, 'SIMULATED_MEASURED', ?, 'SIMULATED_OES', '%', 'OPC_UA_SIMULATOR', '1.0', ?, ?, 1, ?, ?, 'OPC_UA_SIMULATOR_SERVER')`)
        .run(id, heatId, JSON.stringify(reading.composition), 'OPC_UA_SIMULATOR_SERVER', now, id,
          crypto.createHash('sha256').update(JSON.stringify(reading.composition)).digest('hex'));
      require('./premeltGate/store').log('SIMULATED_COMPOSITION_RECORDED', heatId, actor, id);
    }
    db.prepare('INSERT INTO instrument_readings (reading_id, heat_id, reading_json, created_at) VALUES (?, ?, ?, ?)').run(id, heatId || null, JSON.stringify(saved), now);
    return saved;
  });
}
function list() {
  return getDb().prepare('SELECT reading_json FROM instrument_readings ORDER BY created_at DESC').all().map(r => JSON.parse(r.reading_json));
}
module.exports = { eligibleHeat, saveSimulation, list };
