/**
 * Pre-Melt Gate — Durable SQLite-backed Store (Stage 1A).
 *
 * Replaces process-local memory arrays with ACID SQLite persistence.
 * All lots, movements, heats, QA results, gun sessions, counters, and
 * regulatory compliance audit events are permanently stored in SQLite.
 *
 * The 500-event circular buffer truncation is eliminated.
 */
const { MATERIAL_TYPES } = require('./config');
const { getDb, withTransaction, initDb } = require('./db');
const supplierHistory = require('./supplierHistory');

const DAY = 24 * 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms);

function nextId(key, prefix, pad = 4) {
  const db = getDb();
  let nextVal = 1;
  withTransaction((txDb) => {
    const row = txDb.prepare('SELECT val FROM counters WHERE key = ?').get(key);
    if (row) {
      nextVal = row.val + 1;
      txDb.prepare('UPDATE counters SET val = ? WHERE key = ?').run(nextVal, key);
    } else {
      txDb.prepare('INSERT INTO counters (key, val) VALUES (?, ?)').run(key, 1);
    }
  });
  return `${prefix}-${String(nextVal).padStart(pad, '0')}`;
}

function log(type, ref, by, detail) {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_events (at, type, ref, by, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(nowIso, type, ref || null, by || 'system', detail || '');
}

// ------------------------------------------------------------------ lots
function availableKg(lotId) {
  const db = getDb();
  const row = db.prepare('SELECT COALESCE(SUM(kg_scaled), 0) AS total_grams FROM movements WHERE lot_id = ?').get(lotId);
  const grams = Number(row?.total_grams || 0);
  return Math.round(grams) / 1000;
}

function parseLotRow(row) {
  if (!row) return null;
  return {
    lotId: row.lot_id,
    materialType: row.material_type,
    description: row.description,
    alloyName: row.alloy_name,
    supplier: row.supplier,
    truckNo: row.truck_no,
    grnNo: row.grn_no,
    bay: row.bay,
    receivedAt: new Date(row.received_at),
    receivedKg: row.received_kg,
    costPerKg: row.cost_per_kg,
    declared: JSON.parse(row.declared_json || '{}'),
    tested: row.tested_json ? JSON.parse(row.tested_json) : null,
    chemistrySource: row.chemistry_source,
    status: row.status,
    statusReason: row.status_reason,
    restriction: row.restriction_json ? JSON.parse(row.restriction_json) : null,
    flags: JSON.parse(row.flags_json || '[]'),
    storage: JSON.parse(row.storage_json || '{"wet":false}'),
    promisedAt: row.promised_at ? new Date(row.promised_at) : null,
    invoiceKg: row.invoice_kg,
    docs: row.docs_json ? JSON.parse(row.docs_json) : null,
    parentHeatId: row.parent_heat_id,
    simulation: JSON.parse(row.simulation_json || '{"scenario":"clean"}'),
    qaIds: JSON.parse(row.qa_ids_json || '[]'),
    sessionIds: JSON.parse(row.session_ids_json || '[]'),
    version: row.version,
    updatedAt: new Date(row.updated_at),
    previousStatus: row.previous_status,
    decidedBy: row.decided_by
  };
}

function view(lot) {
  if (!lot) return null;
  const { simulation, ...rest } = lot;
  return {
    ...rest,
    materialLabel: MATERIAL_TYPES[lot.materialType]?.label,
    availableKg: availableKg(lot.lotId),
    demoLoadCondition: simulation?.scenario || null,
  };
}

function getLot(lotId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM lots WHERE lot_id = ?').get(lotId);
  return parseLotRow(row);
}

function listLots() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM lots ORDER BY received_at DESC').all();
  return rows.map(parseLotRow);
}

function touch(lot) {
  const db = getDb();
  const nextVer = (lot.version || 1) + 1;
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE lots SET version = ?, updated_at = ? WHERE lot_id = ?').run(nextVer, nowIso, lot.lotId);
  lot.version = nextVer;
  lot.updatedAt = new Date(nowIso);
}

function setStatus(lot, status, reason, by, extra = {}) {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const restriction = extra.restriction ?? (status === 'RESTRICTED' ? lot.restriction : null);
  const decidedBy = extra.decidedBy || lot.decidedBy || null;
  const nextVer = (lot.version || 1) + 1;

  db.prepare(`
    UPDATE lots SET
      status = ?,
      status_reason = ?,
      restriction_json = ?,
      decided_by = ?,
      version = ?,
      updated_at = ?
    WHERE lot_id = ?
  `).run(
    status,
    reason,
    restriction ? JSON.stringify(restriction) : null,
    decidedBy,
    nextVer,
    nowIso,
    lot.lotId
  );

  lot.status = status;
  lot.statusReason = reason;
  lot.restriction = restriction;
  lot.decidedBy = decidedBy;
  lot.version = nextVer;
  lot.updatedAt = new Date(nowIso);

  log('LOT_STATUS', lot.lotId, by, `${status}: ${reason}`);
}

function addLot(data, by) {
  const type = MATERIAL_TYPES[data.materialType];
  const counterKey = `lot_${data.materialType}`;
  
  const db = getDb();
  return withTransaction((txDb) => {
    let nextCounter = (data.materialType === 'RETURNS' ? 0 : 920);
    const existing = txDb.prepare('SELECT val FROM counters WHERE key = ?').get(counterKey);
    if (existing) {
      nextCounter = existing.val + 1;
      txDb.prepare('UPDATE counters SET val = ? WHERE key = ?').run(nextCounter, counterKey);
    } else {
      nextCounter += 1;
      txDb.prepare('INSERT INTO counters (key, val) VALUES (?, ?)').run(counterKey, nextCounter);
    }

    let lotId = data.lotId || `${type.prefix}-${String(nextCounter).padStart(4, '0')}`;
    if (!data.lotId) {
      while (txDb.prepare('SELECT lot_id FROM lots WHERE lot_id = ?').get(lotId)) {
        nextCounter += 1;
        lotId = `${type.prefix}-${String(nextCounter).padStart(4, '0')}`;
        txDb.prepare('UPDATE counters SET val = ? WHERE key = ?').run(nextCounter, counterKey);
      }
    }
    const grnNo = data.grnNo || nextId('grn', 'GRN', 5);
    const nowIso = (data.receivedAt instanceof Date ? data.receivedAt : new Date(data.receivedAt || Date.now())).toISOString();
    const receivedKg = Number(data.receivedKg);
    const costPerKg = Number(data.costPerKg) || 0;
    const initialStatus = data.status || (type.needs ? 'AWAITING_QA' : 'RELEASED');
    const initialReason = data.statusReason || (type.needs === 'GUN'
      ? 'Waiting for handheld XRF/LIBS yard inspection'
      : type.needs === 'LAB' ? 'Waiting for QA lab result' : 'Chemistry from certificate / parent heat');

    const lotRecord = {
      lotId,
      materialType: data.materialType,
      description: data.description || type.label,
      alloyName: data.alloyName || null,
      supplier: data.supplier || 'Unknown supplier',
      truckNo: data.truckNo || null,
      grnNo,
      bay: data.bay || 'Yard',
      receivedAt: new Date(nowIso),
      receivedKg,
      costPerKg,
      declared: data.declared || {},
      tested: data.tested || null,
      chemistrySource: data.chemistrySource || type.trust,
      status: initialStatus,
      statusReason: initialReason,
      restriction: data.restriction || null,
      flags: data.flags || [],
      storage: data.storage || { wet: false },
      promisedAt: data.promisedAt ? new Date(data.promisedAt) : null,
      invoiceKg: Number(data.invoiceKg) > 0 ? Number(data.invoiceKg) : null,
      docs: data.docs || null,
      parentHeatId: data.parentHeatId || null,
      simulation: { scenario: data.demoScenario || 'clean' },
      qaIds: [],
      sessionIds: [],
      version: 1,
      updatedAt: new Date(nowIso)
    };

    txDb.prepare(`
      INSERT INTO lots (
        lot_id, material_type, description, alloy_name, supplier, truck_no, grn_no, bay,
        received_at, received_kg, cost_per_kg, declared_json, tested_json, chemistry_source,
        status, status_reason, restriction_json, flags_json, storage_json, promised_at,
        invoice_kg, docs_json, parent_heat_id, simulation_json, qa_ids_json, session_ids_json,
        version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      lotId,
      lotRecord.materialType,
      lotRecord.description,
      lotRecord.alloyName,
      lotRecord.supplier,
      lotRecord.truckNo,
      lotRecord.grnNo,
      lotRecord.bay,
      nowIso,
      receivedKg,
      costPerKg,
      JSON.stringify(lotRecord.declared),
      lotRecord.tested ? JSON.stringify(lotRecord.tested) : null,
      lotRecord.chemistrySource,
      lotRecord.status,
      lotRecord.statusReason,
      lotRecord.restriction ? JSON.stringify(lotRecord.restriction) : null,
      JSON.stringify(lotRecord.flags),
      JSON.stringify(lotRecord.storage),
      lotRecord.promisedAt ? lotRecord.promisedAt.toISOString() : null,
      lotRecord.invoiceKg,
      lotRecord.docs ? JSON.stringify(lotRecord.docs) : null,
      lotRecord.parentHeatId,
      JSON.stringify(lotRecord.simulation),
      JSON.stringify(lotRecord.qaIds),
      JSON.stringify(lotRecord.sessionIds),
      nowIso
    );

    // Initial receipt movement
    const mvId = nextId('mv', 'MV', 5);
    const kgScaled = Math.round(receivedKg * 1000);
    txDb.prepare(`
      INSERT INTO movements (id, lot_id, type, kg_scaled, kg, heat_id, by, note, at)
      VALUES (?, ?, 'RECEIPT', ?, ?, NULL, ?, ?, ?)
    `).run(mvId, lotId, kgScaled, receivedKg, by || 'stores', `GRN ${grnNo}`, nowIso);

    log('LOT_RECEIVED', lotId, by, `${receivedKg} kg ${lotRecord.description} from ${lotRecord.supplier}`);
    return lotRecord;
  });
}

function addMovement({ lotId, type, kg, heatId, by, note }) {
  const db = getDb();
  return withTransaction((txDb) => {
    const mvId = nextId('mv', 'MV', 5);
    const nowIso = new Date().toISOString();
    const kgNum = Number(kg);
    const kgScaled = Math.round(kgNum * 1000);

    txDb.prepare(`
      INSERT INTO movements (id, lot_id, type, kg_scaled, kg, heat_id, by, note, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(mvId, lotId, type, kgScaled, kgNum, heatId || null, by || 'system', note || '', nowIso);

    const lotRow = txDb.prepare('SELECT * FROM lots WHERE lot_id = ?').get(lotId);
    if (lotRow) {
      const availRow = txDb.prepare('SELECT COALESCE(SUM(kg_scaled), 0) AS g FROM movements WHERE lot_id = ?').get(lotId);
      const remainingKg = Number(availRow.g) / 1000;
      let newStatus = lotRow.status;
      let statusReason = lotRow.status_reason;
      if (remainingKg <= 0.05 && lotRow.status !== 'CONSUMED') {
        newStatus = 'CONSUMED';
        statusReason = 'All stock charged';
      }
      txDb.prepare('UPDATE lots SET version = version + 1, updated_at = ?, status = ?, status_reason = ? WHERE lot_id = ?')
        .run(nowIso, newStatus, statusReason, lotId);
    }

    return { id: mvId, lotId, type, kg: kgNum, heatId: heatId || null, by: by || 'system', note: note || '', at: new Date(nowIso) };
  });
}

function listMovements(lotId) {
  const db = getDb();
  let rows;
  if (lotId) {
    rows = db.prepare('SELECT * FROM movements WHERE lot_id = ? ORDER BY at DESC').all(lotId);
  } else {
    rows = db.prepare('SELECT * FROM movements ORDER BY at DESC').all();
  }
  return rows.map((r) => ({
    id: r.id,
    lotId: r.lot_id,
    type: r.type,
    kg: r.kg,
    heatId: r.heat_id,
    by: r.by,
    note: r.note,
    at: new Date(r.at)
  }));
}

// ------------------------------------------------------------------ QA & Gun
const qa = {
  get(id) {
    const db = getDb();
    const r = db.prepare('SELECT * FROM qa_results WHERE qa_id = ?').get(id);
    if (!r) return null;
    return {
      qaId: r.qa_id,
      lotId: r.lot_id,
      sampleId: r.sample_id,
      sampledAt: r.sampled_at ? new Date(r.sampled_at) : null,
      testedAt: r.tested_at ? new Date(r.tested_at) : null,
      values: JSON.parse(r.values_json || '{}'),
      method: r.method,
      analyst: r.analyst,
      status: r.status,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at ? new Date(r.approved_at) : null,
      enteredAt: r.entered_at ? new Date(r.entered_at) : null,
      calculated: JSON.parse(r.calculated_json || '{}'),
      version: r.version
    };
  },
  list(lotId) {
    const db = getDb();
    let rows;
    if (lotId) {
      rows = db.prepare('SELECT * FROM qa_results WHERE lot_id = ? ORDER BY entered_at DESC').all(lotId);
    } else {
      rows = db.prepare('SELECT * FROM qa_results ORDER BY entered_at DESC').all();
    }
    return rows.map((r) => qa.get(r.qa_id));
  },
  add(rec) {
    const db = getDb();
    const qaId = nextId('qa', 'QA', 5);
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO qa_results (
        qa_id, lot_id, sample_id, sampled_at, tested_at, values_json, method,
        analyst, status, approved_by, approved_at, entered_at, calculated_json, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      qaId,
      rec.lotId,
      rec.sampleId || null,
      rec.sampledAt ? new Date(rec.sampledAt).toISOString() : null,
      rec.testedAt ? new Date(rec.testedAt).toISOString() : null,
      JSON.stringify(rec.values || {}),
      rec.method || null,
      rec.analyst || null,
      rec.status || 'PENDING',
      rec.approvedBy || null,
      rec.approvedAt ? new Date(rec.approvedAt).toISOString() : null,
      rec.enteredAt ? new Date(rec.enteredAt).toISOString() : nowIso,
      JSON.stringify(rec.calculated || {})
    );
    return qa.get(qaId);
  }
};

const sessions = {
  get(id) {
    const db = getDb();
    const r = db.prepare('SELECT * FROM gun_sessions WHERE session_id = ?').get(id);
    if (!r) return null;
    return {
      sessionId: r.session_id,
      lotId: r.lot_id,
      startedAt: r.started_at ? new Date(r.started_at) : null,
      completedAt: r.completed_at ? new Date(r.completed_at) : null,
      ...JSON.parse(r.session_data_json || '{}')
    };
  },
  list(lotId) {
    const db = getDb();
    let rows;
    if (lotId) {
      rows = db.prepare('SELECT * FROM gun_sessions WHERE lot_id = ? ORDER BY started_at DESC').all(lotId);
    } else {
      rows = db.prepare('SELECT * FROM gun_sessions ORDER BY started_at DESC').all();
    }
    return rows.map((r) => sessions.get(r.session_id));
  },
  add(s) {
    const db = getDb();
    const { sessionId, lotId, startedAt, completedAt, ...rest } = s;
    db.prepare(`
      INSERT OR REPLACE INTO gun_sessions (session_id, lot_id, started_at, completed_at, session_data_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      lotId || null,
      startedAt ? new Date(startedAt).toISOString() : null,
      completedAt ? new Date(completedAt).toISOString() : null,
      JSON.stringify(rest)
    );
    return sessions.get(sessionId);
  },
  nextId: () => nextId('gun', 'GUN', 5)
};

// ------------------------------------------------------------------ heats
const heats = {
  get(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM heats WHERE heat_id = ?').get(id);
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
  },
  list() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM heats ORDER BY heat_id DESC').all();
    return rows.map((r) => heats.get(r.heat_id));
  },
  add(h) {
    const db = getDb();
    return withTransaction((txDb) => {
      let nextHeatNum = 1050;
      const cnt = txDb.prepare('SELECT val FROM counters WHERE key = ?').get('heat');
      if (cnt) {
        nextHeatNum = cnt.val + 1;
        txDb.prepare('UPDATE counters SET val = ? WHERE key = ?').run(nextHeatNum, 'heat');
      } else {
        nextHeatNum += 1;
        txDb.prepare('INSERT INTO counters (key, val) VALUES (?, ?)').run('heat', nextHeatNum);
      }

      const heatId = h.heatId || `H-${nextHeatNum}`;
      const nowIso = new Date().toISOString();

      txDb.prepare(`
        INSERT INTO heats (
          heat_id, grade, target_kg, status, version, charge_json, planned_by,
          created_at, updated_at, completed_at, gate_json, gate_history_json,
          start_json, energy_at_start_json, final_chemistry_json, tap_json
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        heatId,
        h.grade || 'SG-IRON',
        Number(h.targetKg) || 1000,
        h.status || 'PLANNED',
        JSON.stringify(h.charge || []),
        h.plannedBy || 'operator',
        nowIso,
        nowIso,
        h.gate ? JSON.stringify(h.gate) : null,
        JSON.stringify(h.gateHistory || []),
        h.start ? JSON.stringify(h.start) : null,
        h.energyAtStart ? JSON.stringify(h.energyAtStart) : null,
        h.finalChemistry ? JSON.stringify(h.finalChemistry) : null,
        h.tap ? JSON.stringify(h.tap) : null
      );

      return heats.get(heatId);
    });
  },
  update(heatId, fields) {
    const db = getDb();
    const existing = heats.get(heatId);
    if (!existing) return null;

    const merged = { ...existing, ...fields };
    const nowIso = new Date().toISOString();

    db.prepare(`
      UPDATE heats SET
        grade = ?,
        target_kg = ?,
        status = ?,
        version = version + 1,
        charge_json = ?,
        planned_by = ?,
        updated_at = ?,
        completed_at = ?,
        gate_json = ?,
        gate_history_json = ?,
        start_json = ?,
        energy_at_start_json = ?,
        final_chemistry_json = ?,
        tap_json = ?
      WHERE heat_id = ?
    `).run(
      merged.grade,
      merged.targetKg,
      merged.status,
      JSON.stringify(merged.charge || []),
      merged.plannedBy || null,
      nowIso,
      merged.completedAt ? merged.completedAt.toISOString() : null,
      merged.gate ? JSON.stringify(merged.gate) : null,
      JSON.stringify(merged.gateHistory || []),
      merged.start ? JSON.stringify(merged.start) : null,
      merged.energyAtStart ? JSON.stringify(merged.energyAtStart) : null,
      merged.finalChemistry ? JSON.stringify(merged.finalChemistry) : null,
      merged.tap ? JSON.stringify(merged.tap) : null,
      heatId
    );

    return heats.get(heatId);
  }
};

// ------------------------------------------------------------------ audit
function audit(limit = null) {
  const db = getDb();
  let rows;
  if (limit && Number(limit) > 0) {
    rows = db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(Number(limit));
  } else {
    rows = db.prepare('SELECT * FROM audit_events ORDER BY id DESC').all();
  }
  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.at),
    type: r.type,
    ref: r.ref,
    by: r.by,
    detail: r.detail
  }));
}

// ------------------------------------------------------------------ seed
const seedHooks = [];
function onSeed(fn) { seedHooks.push(fn); }

function seed(force = false) {
  const db = getDb();
  
  if (!force) {
    const existingLots = db.prepare('SELECT count(*) as c FROM lots').get();
    if (existingLots && existingLots.c > 0) {
      // Already seeded deterministically, preserve committed records!
      return;
    }
  }

  // Clear tables deterministically for re-seed
  withTransaction((txDb) => {
    txDb.exec(`
      DELETE FROM heat_transitions;
      DELETE FROM movements;
      DELETE FROM evidence;
      DELETE FROM qa_results;
      DELETE FROM gun_sessions;
      DELETE FROM invoices;
      DELETE FROM heats;
      DELETE FROM lots;
      DELETE FROM counters;
      DELETE FROM audit_events;
      DELETE FROM idempotency_receipts;
    `);

    txDb.prepare('INSERT INTO counters (key, val) VALUES (?, ?)').run('heat', 1050);
  });

  // Completed heat H-1043
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO heats (
      heat_id, grade, target_kg, status, version, charge_json, planned_by,
      created_at, updated_at, completed_at, final_chemistry_json, gate_history_json
    ) VALUES (?, 'SG-IRON', 1000, 'COMPLETED', 1, '[]', 'Shift A', ?, ?, ?, ?, '[]')
  `).run(
    'H-1043',
    ago(3 * DAY).toISOString(),
    ago(3 * DAY).toISOString(),
    ago(3 * DAY).toISOString(),
    JSON.stringify({ Fe: 93.43, C: 3.6, Si: 2.45, Mn: 0.3, P: 0.035, S: 0.012, Cu: 0.05, Cr: 0.03, Ni: 0.03, Mo: 0.005, Sn: 0.004 })
  );

  const T = 'Trichy Iron & Alloys';
  addLot({ lotId: 'PIG-0901', materialType: 'PIG_IRON', description: 'SG-grade pig iron (low Mn, low P)', supplier: 'Kovai Pig Iron Co.', receivedKg: 4000, costPerKg: 50, receivedAt: ago(6 * DAY), bay: 'Bay 1',
    declared: { C: 4.1, Si: 1.1, Mn: 0.08, P: 0.035, S: 0.015, Cu: 0.01, Cr: 0.02, Ni: 0.02, Mo: 0.005, Sn: 0.002 } }, 'stores');
  addLot({ lotId: 'RET-1043', materialType: 'RETURNS', description: 'SG iron returns (runners, risers) from H-1043', supplier: 'In-house', receivedKg: 2500, costPerKg: 38, receivedAt: ago(3 * DAY), bay: 'Bay 2',
    parentHeatId: 'H-1043', declared: { C: 3.6, Si: 2.45, Mn: 0.3, P: 0.035, S: 0.012, Cu: 0.05, Cr: 0.03, Ni: 0.03, Mo: 0.005, Sn: 0.004 } }, 'melt shop');
  addLot({ lotId: 'SCR-0912', materialType: 'STEEL_SCRAP', description: 'CRCA bundles (clean low-carbon sheet)', supplier: 'Sri Balaji Scrap Traders', truckNo: 'TN 38 BK 4412', receivedKg: 6000, costPerKg: 36, receivedAt: ago(2 * DAY), bay: 'Bay 3',
    demoScenario: 'clean', declared: { C: 0.05, Si: 0.02, Mn: 0.25, P: 0.015, S: 0.012, Cu: 0.04, Cr: 0.03, Ni: 0.03, Mo: 0.01, Sn: 0.01 } }, 'stores');
  addLot({ lotId: 'SCR-0913', materialType: 'STEEL_SCRAP', description: 'HMS 1&2 mixed heavy melting scrap', supplier: 'Coimbatore Metal Recyclers', truckNo: 'TN 37 CY 9081', receivedKg: 8000, costPerKg: 33, receivedAt: ago(0.1 * DAY), bay: 'Bay 4',
    demoScenario: 'copper', declared: { C: 0.2, Si: 0.2, Mn: 0.65, P: 0.03, S: 0.03, Cu: 0.2, Cr: 0.1, Ni: 0.08, Mo: 0.02, Sn: 0.015 } }, 'stores');
  addLot({ lotId: 'SCR-0914', materialType: 'STEEL_SCRAP', description: 'Shredded steel scrap', supplier: 'Pollachi Steel Scrap', truckNo: 'TN 41 AL 2230', receivedKg: 5000, costPerKg: 34, receivedAt: ago(0.2 * DAY), bay: 'Bay 5',
    demoScenario: 'stainless', declared: { C: 0.12, Si: 0.15, Mn: 0.5, P: 0.025, S: 0.025, Cu: 0.15, Cr: 0.08, Ni: 0.06, Mo: 0.015, Sn: 0.012 } }, 'stores');
  addLot({ lotId: 'CIS-0915', materialType: 'CI_SCRAP', description: 'Grey iron machine castings (painted)', supplier: 'Tiruppur Castings Scrap', truckNo: 'TN 39 BZ 7710', receivedKg: 3000, costPerKg: 34, receivedAt: ago(1 * DAY), bay: 'Bay 6',
    demoScenario: 'dirty', declared: { C: 3.3, Si: 2.0, Mn: 0.65, P: 0.12, S: 0.09, Cu: 0.25, Cr: 0.15, Ni: 0.05, Mo: 0.02, Sn: 0.02 } }, 'stores');

  const dri1 = addLot({ lotId: 'DRI-0911', materialType: 'DRI', description: 'Coal-based sponge iron lumps', supplier: T, truckNo: 'TN 45 AF 1122', receivedKg: 3000, costPerKg: 28, receivedAt: ago(2 * DAY), bay: 'Covered shed',
    declared: { feTotal: 91, feMetallic: 81.9, C: 0.15, P: 0.045, S: 0.018, SiO2: 5, Al2O3: 2.5, fines: 3 } }, 'stores');
  const qa1 = {
    qaId: 'QA-00001', lotId: dri1.lotId, version: 1, sampleId: 'S-0911-1', sampledAt: ago(1.8 * DAY), testedAt: ago(1.6 * DAY),
    values: { feTotal: 90.8, feMetallic: 81.5, C: 0.14, S: 0.018, P: 0.045, SiO2: 5.2, Al2O3: 2.6, CaO: 0.9, MgO: 0.4, moisture: 0.3, fines: 2.8 },
    method: 'Ferric chloride', analyst: 'R. Priya (QA)', status: 'APPROVED', approvedBy: 'K. Senthil (QA Head)', approvedAt: ago(1.5 * DAY), enteredAt: ago(1.6 * DAY),
    calculated: { metallization: 89.76, equivalentMetallization: 90.46 },
  };
  qa.add(qa1);
  db.prepare('UPDATE lots SET status = ?, status_reason = ?, chemistry_source = ?, tested_json = ? WHERE lot_id = ?')
    .run('RELEASED', 'QA approved: metallization 89.8%, P 0.045%', 'LAB', JSON.stringify(qa1.values), dri1.lotId);

  addLot({ lotId: 'DRI-0917', materialType: 'DRI', description: 'Coal-based sponge iron lumps', supplier: T, truckNo: 'TN 45 AF 1187', receivedKg: 3500, costPerKg: 27, receivedAt: ago(0.15 * DAY), bay: 'Covered shed',
    declared: { feTotal: 91, feMetallic: 82, C: 0.15, P: 0.05, S: 0.02, SiO2: 5, Al2O3: 2.5, fines: 3 } }, 'stores');

  addLot({ lotId: 'ALY-0903', materialType: 'FERROALLOY', alloyName: 'FeSi-75', description: 'Ferrosilicon 75% (10–50 mm)', supplier: 'Nava Bharat Ferro Alloys', receivedKg: 500, costPerKg: 105, receivedAt: ago(10 * DAY), bay: 'Alloy store',
    declared: { C: 0.1, Si: 75, Mn: 0.3, P: 0.03, S: 0.01 } }, 'stores');
  addLot({ lotId: 'ALY-0904', materialType: 'FERROALLOY', alloyName: 'HC FeMn', description: 'High-carbon ferromanganese', supplier: 'Maithan Alloys', receivedKg: 300, costPerKg: 78, receivedAt: ago(12 * DAY), bay: 'Alloy store',
    declared: { C: 6.8, Si: 1.0, Mn: 70, P: 0.25, S: 0.02 } }, 'stores');
  addLot({ lotId: 'ALY-0905', materialType: 'FERROALLOY', alloyName: 'Recarburiser', description: 'Calcined petroleum coke recarburiser', supplier: 'Goa Carbon', receivedKg: 400, costPerKg: 65, receivedAt: ago(9 * DAY), bay: 'Alloy store',
    declared: { C: 98.5, S: 0.4 } }, 'stores');

  heats.add({
    heatId: 'H-1051', grade: 'SG-IRON', targetKg: 1020, status: 'PLANNED', plannedBy: 'Shift B supervisor', createdAt: new Date(),
    charge: [
      { lotId: 'PIG-0901', kg: 400 },
      { lotId: 'RET-1043', kg: 500 },
      { lotId: 'SCR-0912', kg: 100 },
      { lotId: 'ALY-0903', kg: 12 },
      { lotId: 'ALY-0904', kg: 8 },
    ],
    gate: null, gateHistory: [],
  });
  heats.add({
    heatId: 'H-1052', grade: 'SG-IRON', targetKg: 1000, status: 'PLANNED', plannedBy: 'Shift A supervisor', createdAt: new Date(),
    charge: [{ lotId: 'PIG-0901', kg: 350 }, { lotId: 'DRI-0911', kg: 350 }, { lotId: 'RET-1043', kg: 300 }],
    gate: null, gateHistory: [],
  });

  // Call seed hooks
  seedHooks.forEach((fn) => { try { fn(); } catch (e) { console.error('seed hook failed:', e.message); } });
}

// Initialize and auto-seed on module load
initDb();
seed(false);

module.exports = {
  seed: (force = true) => seed(force),
  onSeed,
  log,
  getLot,
  listLots,
  addLot,
  view,
  availableKg,
  setStatus,
  touch,
  addMovement,
  listMovements,
  qa,
  sessions,
  heats,
  audit,
};
