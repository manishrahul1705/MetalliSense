/**
 * Atomic, Idempotent Inventory Ledger for Additives and Charge materials.
 * Guarantees all-or-nothing transactional deductions, strict quantity validation,
 * integer-base balance calculation, and duplicate request idempotency receipts.
 */
const crypto = require('crypto');
const { getDb, withTransaction } = require('./db');

function err(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

// Convert kilograms to integer base units (grams) to avoid floating-point errors
function toGrams(kg) {
  return Math.round(Number(kg) * 1000);
}

function fromGrams(grams) {
  return Math.round(grams) / 1000;
}

// Check excessive precision: maximum 3 decimal places (gram resolution)
function hasExcessivePrecision(num) {
  const s = String(num);
  const parts = s.split('.');
  return parts.length > 1 && parts[1].length > 3;
}

/**
 * Computes available kg for a lot from the movements table using integer base units.
 */
function getAvailableGrams(db, lotId) {
  const row = db.prepare('SELECT COALESCE(SUM(kg_scaled), 0) AS total_grams FROM movements WHERE lot_id = ?').get(lotId);
  return Number(row.total_grams || 0);
}

function getAvailableKg(db, lotId) {
  return fromGrams(getAvailableGrams(db, lotId));
}

/**
 * Deduct additives atomically with idempotency and strict boundary validation.
 */
function deductAdditivesAtomic({ lines, heatId, idempotencyKey, by, note }) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw err(400, "Header 'Idempotency-Key' or field 'idempotencyKey' is required for inventory mutations");
  }
  const cleanKey = idempotencyKey.trim();

  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    throw err(400, "Request must contain a non-empty 'lines' array");
  }

  const db = getDb();

  // 1. Check existing idempotency receipt
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ lines, heatId })).digest('hex');
  const existingReceipt = db.prepare('SELECT * FROM idempotency_receipts WHERE idempotency_key = ?').get(cleanKey);

  if (existingReceipt) {
    if (existingReceipt.request_hash !== payloadHash) {
      throw err(409, `Idempotency key '${cleanKey}' was already used with a different request payload`, {
        code: 'IDEMPOTENCY_CONFLICT'
      });
    }
    // Idempotent retry: return previous response receipt without re-deducting
    return {
      idempotent_replay: true,
      statusCode: existingReceipt.status_code,
      data: JSON.parse(existingReceipt.response_json)
    };
  }

  // 2. Validate Heat existence and status
  const targetHeatId = heatId || (lines[0] && lines[0].heatId);
  if (!targetHeatId || typeof targetHeatId !== 'string') {
    throw err(400, "A valid 'heatId' must be provided in the request or in each line");
  }

  const heatRow = db.prepare('SELECT * FROM heats WHERE heat_id = ?').get(targetHeatId);
  if (!heatRow) {
    throw err(404, `Heat '${targetHeatId}' not found`);
  }

  const allowedPhases = new Set([
    'MELTING',
    'AWAITING_MEASURED_CHEMISTRY',
    'CORRECTION_PENDING',
    'AWAITING_POST_CORRECTION_MEASUREMENT',
    'QUALITY_REVIEW'
  ]);

  if (!allowedPhases.has(heatRow.status)) {
    throw err(409, `Cannot deduct inventory for heat '${targetHeatId}' in phase '${heatRow.status}'. Heat must be in an active melting or correction phase.`);
  }

  // 3. Pre-validate all lines structurally before database transaction
  const aggregatedDemands = new Map(); // lotId -> { grams, alloyName, originalLines }

  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if (!l || typeof l !== 'object') {
      throw err(400, `Line ${idx} is invalid`);
    }

    if (!l.lotId || typeof l.lotId !== 'string') {
      throw err(400, `Line ${idx}: valid 'lotId' string is required`);
    }

    // Strict number validation (reject strings, NaN, Infinity, negative, zero)
    if (typeof l.kg !== 'number' || !Number.isFinite(l.kg)) {
      throw err(400, `Line ${idx} (${l.lotId}): kg must be a finite positive number`);
    }

    if (l.kg <= 0) {
      throw err(400, `Line ${idx} (${l.lotId}): kg must be greater than zero`);
    }

    if (hasExcessivePrecision(l.kg)) {
      throw err(400, `Line ${idx} (${l.lotId}): kg exceeds maximum allowed precision of 3 decimal places`);
    }

    const demandGrams = toGrams(l.kg);
    const prev = aggregatedDemands.get(l.lotId) || { grams: 0, alloyName: l.alloyName || null, count: 0 };
    aggregatedDemands.set(l.lotId, {
      grams: prev.grams + demandGrams,
      alloyName: l.alloyName || prev.alloyName,
      count: prev.count + 1
    });
  }

  // 4. Execute atomic transaction
  return withTransaction((txDb) => {
    const results = [];
    const nowIso = new Date().toISOString();
    const actorStr = String(by || lines[0].by || 'unverified_operator').trim();

    // Check every lot existence and available balance
    for (const [lotId, demand] of aggregatedDemands.entries()) {
      const lotRow = txDb.prepare('SELECT * FROM lots WHERE lot_id = ?').get(lotId);
      if (!lotRow) {
        throw err(404, `Lot '${lotId}' not found`);
      }
      if (lotRow.material_type !== 'FERROALLOY') {
        throw err(400, `Lot '${lotId}' is not a FERROALLOY lot (type: ${lotRow.material_type})`);
      }

      const availableGrams = getAvailableGrams(txDb, lotId);
      if (demand.grams > availableGrams) {
        const availableKg = fromGrams(availableGrams);
        const requestedKg = fromGrams(demand.grams);
        throw err(409, `Insufficient inventory for lot '${lotId}': requested ${requestedKg} kg, but only ${availableKg} kg available in stock`, {
          lotId,
          requestedKg,
          availableKg
        });
      }
    }

    // All lots validated and have sufficient stock: perform deductions
    for (const [lotId, demand] of aggregatedDemands.entries()) {
      const lotRow = txDb.prepare('SELECT * FROM lots WHERE lot_id = ?').get(lotId);
      const deductKg = fromGrams(demand.grams);
      const deductGrams = demand.grams;
      const movementId = `MV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      // Insert negative movement (CHARGE)
      txDb.prepare(`
        INSERT INTO movements (id, lot_id, type, kg_scaled, kg, heat_id, by, note, at)
        VALUES (?, ?, 'CHARGE', ?, ?, ?, ?, ?, ?)
      `).run(
        movementId,
        lotId,
        -deductGrams,
        -deductKg,
        targetHeatId,
        actorStr,
        note || `Atomic deduction for heat ${targetHeatId}: ${demand.alloyName || lotRow.alloy_name || lotRow.description}`,
        nowIso
      );

      const remainingGrams = getAvailableGrams(txDb, lotId);
      const remainingKg = fromGrams(remainingGrams);

      // Update lot version and status if depleted
      let newStatus = lotRow.status;
      let statusReason = lotRow.status_reason;
      if (remainingGrams <= 50 && lotRow.status !== 'CONSUMED') { // <= 0.05 kg
        newStatus = 'CONSUMED';
        statusReason = `All stock charged to heat ${targetHeatId}`;
      }

      txDb.prepare(`
        UPDATE lots SET
          version = version + 1,
          updated_at = ?,
          status = ?,
          status_reason = ?
        WHERE lot_id = ?
      `).run(nowIso, newStatus, statusReason, lotId);

      results.push({
        lotId,
        deductedKg: deductKg,
        remainingKg
      });
    }

    // Record audit event
    txDb.prepare(`
      INSERT INTO audit_events (at, type, ref, by, detail)
      VALUES (?, 'ADDITIVE_DEDUCTED', ?, ?, ?)
    `).run(
      nowIso,
      targetHeatId,
      actorStr,
      `Atomically deducted ${results.length} lot(s) (${results.map((r) => `${r.lotId}: ${r.deductedKg}kg`).join(', ')}) for heat ${targetHeatId}`
    );

    const responsePayload = {
      heatId: targetHeatId,
      deducted: results,
      timestamp: nowIso
    };

    // Store idempotency receipt
    txDb.prepare(`
      INSERT INTO idempotency_receipts (idempotency_key, request_hash, status_code, response_json, created_at)
      VALUES (?, ?, 200, ?, ?)
    `).run(
      cleanKey,
      payloadHash,
      JSON.stringify(responsePayload),
      nowIso
    );

    return {
      idempotent_replay: false,
      statusCode: 200,
      data: responsePayload
    };
  });
}

module.exports = {
  deductAdditivesAtomic,
  getAvailableGrams,
  getAvailableKg,
  toGrams,
  fromGrams
};
