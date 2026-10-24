/**
 * Explicit server-owned Heat State Machine.
 * Enforces valid transition paths, optimistic concurrency control (version checks),
 * and immutable transition event logging.
 */
const crypto = require('crypto');
const { getDb, withTransaction } = require('./db');

const HEAT_STATES = {
  PLANNED: 'PLANNED',
  GATE_EVALUATED: 'GATE_EVALUATED',
  AUTHORIZED_TO_START: 'AUTHORIZED_TO_START',
  MELTING: 'MELTING',
  AWAITING_MEASURED_CHEMISTRY: 'AWAITING_MEASURED_CHEMISTRY',
  CORRECTION_PENDING: 'CORRECTION_PENDING',
  AWAITING_POST_CORRECTION_MEASUREMENT: 'AWAITING_POST_CORRECTION_MEASUREMENT',
  AWAITING_MECHANICAL_EVIDENCE: 'AWAITING_MECHANICAL_EVIDENCE',
  QUALITY_REVIEW: 'QUALITY_REVIEW',
  COMPLETED: 'COMPLETED',
  RELEASED: 'RELEASED',
  HELD: 'HELD',
  REJECTED: 'REJECTED'
};

const TERMINAL_STATES = new Set([
  HEAT_STATES.RELEASED,
  HEAT_STATES.REJECTED
]);

const ALLOWED_TRANSITIONS = {
  [HEAT_STATES.PLANNED]: new Set([
    HEAT_STATES.GATE_EVALUATED,
    HEAT_STATES.MELTING,
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.GATE_EVALUATED]: new Set([
    HEAT_STATES.AUTHORIZED_TO_START,
    HEAT_STATES.MELTING,
    HEAT_STATES.GATE_EVALUATED, // Re-running pre-melt checks on modified charge
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.AUTHORIZED_TO_START]: new Set([
    HEAT_STATES.MELTING,
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.MELTING]: new Set([
    HEAT_STATES.AWAITING_MEASURED_CHEMISTRY,
    HEAT_STATES.QUALITY_REVIEW, // Direct tap path if chemistry recorded with tap
    HEAT_STATES.COMPLETED,      // Backwards compatibility tap path with verified evidence
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.AWAITING_MEASURED_CHEMISTRY]: new Set([
    HEAT_STATES.CORRECTION_PENDING,
    HEAT_STATES.AWAITING_MECHANICAL_EVIDENCE,
    HEAT_STATES.QUALITY_REVIEW,
    HEAT_STATES.COMPLETED,
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.CORRECTION_PENDING]: new Set([
    HEAT_STATES.AWAITING_POST_CORRECTION_MEASUREMENT,
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.AWAITING_POST_CORRECTION_MEASUREMENT]: new Set([
    HEAT_STATES.CORRECTION_PENDING,
    HEAT_STATES.AWAITING_MECHANICAL_EVIDENCE,
    HEAT_STATES.QUALITY_REVIEW,
    HEAT_STATES.COMPLETED,
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.AWAITING_MECHANICAL_EVIDENCE]: new Set([
    HEAT_STATES.QUALITY_REVIEW,
    HEAT_STATES.COMPLETED,
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.QUALITY_REVIEW]: new Set([
    HEAT_STATES.COMPLETED,
    HEAT_STATES.HELD,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.COMPLETED]: new Set([
    HEAT_STATES.RELEASED,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.HELD]: new Set([
    HEAT_STATES.PLANNED,
    HEAT_STATES.GATE_EVALUATED,
    HEAT_STATES.MELTING,
    HEAT_STATES.AWAITING_MEASURED_CHEMISTRY,
    HEAT_STATES.CORRECTION_PENDING,
    HEAT_STATES.QUALITY_REVIEW,
    HEAT_STATES.REJECTED
  ]),
  [HEAT_STATES.RELEASED]: new Set([]), // Terminal
  [HEAT_STATES.REJECTED]: new Set([])  // Terminal
};

function canTransition(fromState, toState) {
  const allowed = ALLOWED_TRANSITIONS[fromState];
  return allowed ? allowed.has(toState) : false;
}

function err(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function transitionHeat(heatId, targetState, { expectedVersion, actor, note, extraUpdates = {} } = {}) {
  return withTransaction((db) => {
    const row = db.prepare('SELECT * FROM heats WHERE heat_id = ?').get(heatId);
    if (!row) {
      throw err(404, `Heat ${heatId} not found`);
    }

    const currentState = row.status;

    // Check terminal states
    if (TERMINAL_STATES.has(currentState)) {
      throw err(409, `Cannot transition heat ${heatId} from terminal state ${currentState}`);
    }

    // Check optimistic concurrency version if specified
    if (expectedVersion !== undefined && expectedVersion !== null) {
      if (Number(expectedVersion) !== row.version) {
        throw err(409, `Optimistic concurrency conflict on heat ${heatId}: expected version ${expectedVersion}, but current version is ${row.version}`);
      }
    }

    // Check transition path
    if (currentState === targetState && !canTransition(currentState, targetState)) {
      if (!extraUpdates || Object.keys(extraUpdates).length === 0) {
        // Idempotent retry: return current heat without duplicate event
        return parseHeatRow(row);
      }
    }

    if (currentState !== targetState && !canTransition(currentState, targetState)) {
      throw err(409, `Forbidden heat state transition: cannot transition heat ${heatId} from '${currentState}' to '${targetState}'`);
    }

    const nextVersion = row.version + 1;
    const nowIso = new Date().toISOString();
    const eventId = `EVT-TR-${heatId}-${nextVersion}-${Date.now().toString(36)}`;
    const actorStr = String(actor || 'unverified_actor').trim();

    // Record transition event
    db.prepare(`
      INSERT INTO heat_transitions (event_id, heat_id, prev_state, new_state, version, actor, at, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, heatId, currentState, targetState, nextVersion, actorStr, nowIso, note || '');

    // Prepare update fields
    let completedAt = row.completed_at;
    if (targetState === HEAT_STATES.COMPLETED && !completedAt) {
      completedAt = nowIso;
    }

    const mergedChargeJson = extraUpdates.charge_json || row.charge_json;
    const mergedGateJson = extraUpdates.gate_json !== undefined ? extraUpdates.gate_json : row.gate_json;
    const mergedGateHistoryJson = extraUpdates.gate_history_json !== undefined ? extraUpdates.gate_history_json : row.gate_history_json;
    const mergedStartJson = extraUpdates.start_json !== undefined ? extraUpdates.start_json : row.start_json;
    const mergedEnergyAtStart = extraUpdates.energy_at_start_json !== undefined ? extraUpdates.energy_at_start_json : row.energy_at_start_json;
    const mergedFinalChem = extraUpdates.final_chemistry_json !== undefined ? extraUpdates.final_chemistry_json : row.final_chemistry_json;
    const mergedTap = extraUpdates.tap_json !== undefined ? extraUpdates.tap_json : row.tap_json;

    db.prepare(`
      UPDATE heats SET
        status = ?,
        version = ?,
        updated_at = ?,
        completed_at = ?,
        charge_json = ?,
        gate_json = ?,
        gate_history_json = ?,
        start_json = ?,
        energy_at_start_json = ?,
        final_chemistry_json = ?,
        tap_json = ?
      WHERE heat_id = ?
    `).run(
      targetState,
      nextVersion,
      nowIso,
      completedAt,
      mergedChargeJson,
      mergedGateJson,
      mergedGateHistoryJson,
      mergedStartJson,
      mergedEnergyAtStart,
      mergedFinalChem,
      mergedTap,
      heatId
    );

    // Audit log
    db.prepare(`
      INSERT INTO audit_events (at, type, ref, by, detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      nowIso,
      'HEAT_STATE_TRANSITION',
      heatId,
      actorStr,
      `State transition from ${currentState} to ${targetState} (v${nextVersion})`
    );

    const updatedRow = db.prepare('SELECT * FROM heats WHERE heat_id = ?').get(heatId);
    return parseHeatRow(updatedRow);
  });
}

function parseHeatRow(row) {
  if (!row) return null;
  return {
    heatId: row.heat_id,
    grade: row.grade,
    targetKg: row.target_kg,
    status: row.status,
    version: row.version,
    charge: JSON.parse(row.charge_json || '[]'),
    plannedBy: row.planned_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    gate: row.gate_json ? JSON.parse(row.gate_json) : null,
    gateHistory: JSON.parse(row.gate_history_json || '[]'),
    start: row.start_json ? JSON.parse(row.start_json) : null,
    energyAtStart: row.energy_at_start_json ? JSON.parse(row.energy_at_start_json) : null,
    finalChemistry: row.final_chemistry_json ? JSON.parse(row.final_chemistry_json) : null,
    tap: row.tap_json ? JSON.parse(row.tap_json) : null
  };
}

function getHeatTransitions(heatId) {
  const db = getDb();
  let rows;
  if (heatId) {
    rows = db.prepare('SELECT * FROM heat_transitions WHERE heat_id = ? ORDER BY at ASC').all(heatId);
  } else {
    rows = db.prepare('SELECT * FROM heat_transitions ORDER BY at ASC').all();
  }
  return rows.map((r) => ({
    eventId: r.event_id,
    heatId: r.heat_id,
    prevState: r.prev_state,
    newState: r.new_state,
    version: r.version,
    actor: r.actor,
    at: new Date(r.at),
    note: r.note
  }));
}

module.exports = {
  HEAT_STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  canTransition,
  transitionHeat,
  getHeatTransitions,
  parseHeatRow
};
