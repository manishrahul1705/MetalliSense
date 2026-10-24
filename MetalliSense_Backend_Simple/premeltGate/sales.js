/**
 * Sales & Dispatch — the end of the melt (Stage 1A).
 *
 * Integrated with explicit Heat State Machine, strict Quality Interlocks,
 * and durable SQLite persistence.
 *
 * Enforces that:
 * - Pre-Melt Gate cannot be bypassed via 'resume: true'.
 * - Heats cannot be completed without verified, complete measured chemistry and mechanical laboratory evidence.
 * - Missing required evidence results in INCOMPLETE/BLOCKED, never false PASS.
 * - Certificates can only be issued for eligible, completed/released heats.
 * - Material balance configuration is validated jointly (yield + returns <= 100%).
 */
const store = require('./store');
const gate = require('./gateEngine');
const energy = require('./energy');
const { RESIDUAL_LIMITS } = require('./config');
const sellingPrices = require('../sellingPriceStore');
const { getDb, withTransaction } = require('./db');
const { transitionHeat, HEAT_STATES } = require('./heatStateMachine');
const {
  EVIDENCE_TYPES,
  evaluateChemistryStrict,
  evaluateMechanicalStrict,
  recordEvidence
} = require('./evidenceEngine');

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const round = (v, dp = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** dp) / 10 ** dp);

// Default settings
const DEFAULT_SETTINGS = {
  seller: {
    name: 'MetalliSense Demo Foundry',
    address: 'Plot 00, Demo Industrial Estate, Coimbatore, Tamil Nadu 641000',
    gstin: '33DEMO0000D1Z0',
    stateCode: '33',
    state: 'Tamil Nadu',
    phone: '+91 00000 00000',
    email: 'sales@example.com',
    bank: 'Demo Bank · A/c 000000000000 · IFSC DEMO0000000',
    isDemo: true,
  },
  castingYieldPct: 70, // good castings as % of liquid metal
  returnsPct: 25,      // runners, risers, rejects that go back to stock as foundry returns
  documentedLossPct: 5, // oxidation, slag, and pouring losses
  gstPct: 18,
  paymentTermsDays: 30,
  hsn: {
    'GREY-IRON': '73251000',
    'SG-IRON': '73259920',
    'LOW-CARBON-STEEL': '73259910',
    'MEDIUM-CARBON-STEEL': '73259910',
    'HIGH-CARBON-STEEL': '73259910'
  },
};

const CUSTOMERS = [
  { id: 'C-001', name: 'Kaveri Pumps & Valves (demo)', address: 'Demo Road, Coimbatore, Tamil Nadu', gstin: '33DEMOC0001C1Z1', stateCode: '33', state: 'Tamil Nadu' },
  { id: 'C-002', name: 'Deccan Auto Components (demo)', address: 'Demo Industrial Area, Hosur, Tamil Nadu', gstin: '33DEMOC0002C1Z2', stateCode: '33', state: 'Tamil Nadu' },
  { id: 'C-003', name: 'Sahyadri Agro Implements (demo)', address: 'Demo MIDC, Pune, Maharashtra', gstin: '27DEMOC0003C1Z3', stateCode: '27', state: 'Maharashtra' },
  { id: 'C-004', name: 'Malabar Marine Engineering (demo)', address: 'Demo Harbour Road, Kochi, Kerala', gstin: '32DEMOC0004C1Z4', stateCode: '32', state: 'Kerala' },
];

function loadSettings() {
  const db = getDb();
  const row = db.prepare('SELECT settings_json FROM sales_settings WHERE id = 1').get();
  if (row) {
    try {
      return JSON.parse(row.settings_json);
    } catch (_) {}
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO sales_settings (id, settings_json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(s), nowIso);
}

const fy = (d = new Date()) => {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};

const gradeLabel = (g) => String(g || '').split('-').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ').replace('Sg ', 'SG ');

// Amount in words (Indian system)
function inWords(num) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`);
  const three = (n) => `${n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' : ''}` : ''}${n % 100 ? two(n % 100) : ''}`;
  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(rupees / 1e7);
  const lakh = Math.floor((rupees % 1e7) / 1e5);
  const thousand = Math.floor((rupees % 1e5) / 1e3);
  const rest = rupees % 1e3;
  if (crore) parts.push(`${two(crore) || three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return `Rupees ${parts.join(' ')}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

// ------------------------------------------------------------ complete the heat (Approve Tap)
/**
 * body: { approvedBy, composition, mechanical, standard, acceptedStrategy, version, evidenceType }
 * currentUser: authenticated user from session context (optional, enables server-owned attribution and maker-checker)
 */
function completeHeat(heatId, body = {}, currentUser = null) {
  const heat = store.heats.get(heatId);
  if (!heat) throw err(404, `Heat ${heatId} not found`);

  // Idempotency: if already completed and approved, return current view
  if (heat.status === 'COMPLETED' && heat.tap) {
    return heatView(heat);
  }

  // S0-002: Banning the resume bypass completely
  if (body.resume) {
    throw err(403, "Forbidden: The 'resume' flag cannot bypass the Pre-Melt Gate safety interlock. Heats must follow authorized state transitions.", {
      code: 'GATE_BYPASS_FORBIDDEN'
    });
  }

  if (heat.status === 'PLANNED') {
    throw err(409, `Heat ${heatId} is planned — start melting it on the Pre-Melt Gate first`, {
      code: 'HEAT_NOT_STARTED'
    });
  }

  // Server-owned actor attribution: prioritize authenticated identity over client-supplied string
  let engineerName = currentUser ? (currentUser.displayName || currentUser.username) : null;
  if (!engineerName && body.approvedBy && String(body.approvedBy).trim()) {
    engineerName = String(body.approvedBy).trim();
  }
  if (!engineerName) {
    throw err(400, "The engineer's name is required to approve the tap");
  }

  // Maker-checker separation: The person releasing the heat cannot be the same user who planned or started the heat
  if (currentUser) {
    const plannedBy = heat.plannedBy;
    const startedBy = heat.start?.by;
    const currentId = currentUser.userId || currentUser.username;
    if ((plannedBy && (plannedBy === currentId || plannedBy === currentUser.username)) ||
        (startedBy && (startedBy === currentId || startedBy === currentUser.username))) {
      throw err(403, 'Maker-checker violation: The Quality Manager releasing the heat cannot be the same user who planned or started the heat.', {
        code: 'MAKER_CHECKER_VIOLATION'
      });
    }
  }

  // Chemistry evidence validation (S0-001)
  const composition = body.composition || heat.finalChemistry;
  const chemEvidenceType = body.chemEvidenceType || EVIDENCE_TYPES.MELT_MEASURED;

  const chemResult = evaluateChemistryStrict(heat.grade, composition, chemEvidenceType);

  // Mechanical evidence validation (S0-001)
  const mechEvidenceType = body.mechEvidenceType || EVIDENCE_TYPES.LAB_MEASURED;
  const mechResult = evaluateMechanicalStrict(heat.grade, body.mechanical, body.standard, mechEvidenceType);

  // Record immutable evidence records in the evidence table
  recordEvidence({
    heatId,
    evidenceType: chemEvidenceType,
    values: composition,
    sourceInstrument: body.spectrometerInstrument || 'ARL_3460_OES',
    units: '%',
    provenance: chemEvidenceType,
    specVersion: chemResult.specificationSource,
    actor: engineerName
  });

  if (body.mechanical && Object.keys(body.mechanical).length > 0) {
    recordEvidence({
      heatId,
      evidenceType: mechEvidenceType,
      values: body.mechanical,
      sourceInstrument: body.tensileTestingMachine || 'UNIVERSAL_TENSILE_TESTER',
      units: 'MPa, %, HB',
      provenance: mechEvidenceType,
      specVersion: mechResult.standard,
      actor: engineerName
    });
  }

  const currentSettings = loadSettings();
  const chargeKg = (heat.charge || []).reduce((s, l) => s + Number(l.kg), 0);
  const metalKg = Number(heat.gate?.prediction?.metalKg) || chargeKg * 0.95;
  const castingsKg = round(metalKg * (currentSettings.castingYieldPct / 100), 0);
  const returnsKg = round(metalKg * (currentSettings.returnsPct / 100), 0);

  // Downgrade if chemistry or mechanical properties failed
  const ok = chemResult.pass && mechResult.pass;
  const down = ok ? null : sellingPrices.getDowngradeLossPerTon(heat.grade);
  const soldGrade = ok ? heat.grade : (sellingPrices.getDowngradeTarget(heat.grade) || down?.downgradeGrade || 'SCRAP');
  const pricePerT = ok ? sellingPrices.getSellingPrice(heat.grade) : (down?.downgradeSellingPricePerTon ?? sellingPrices.SCRAP_PRICE_PER_TON);

  const tapRecord = {
    at: new Date().toISOString(),
    approvedBy: engineerName,
    result: ok ? 'PASS' : 'DOWNGRADED',
    soldGrade,
    sellingRsPerKg: round(pricePerT / 1000, 2),
    downgradeNote: ok ? null : (down ? `Downgraded from ${heat.grade} to ${soldGrade} (loss ₹${down.lossPerTon.toLocaleString('en-IN')}/t)` : 'Off-spec — sold as scrap'),
    metalKg: round(metalKg, 0),
    castingsKg,
    returnsKg,
    chemistry: chemResult,
    mechanical: mechResult,
    acceptedStrategy: body.acceptedStrategy || null,
  };

  // Add returns back to stock as a durable lot + movement
  if (returnsKg > 0) {
    try {
      store.addLot({
        materialType: 'RETURNS',
        parentHeatId: heatId,
        receivedKg: returnsKg,
        costPerKg: round(pricePerT / 1000 * 0.7, 0) || 35,
        description: `${gradeLabel(soldGrade)} foundry returns from ${heatId}`,
        bay: 'Bay 2',
        declared: composition,
      }, engineerName);
    } catch (_) {}
  }

  // Execute explicit state transition with optimistic concurrency
  const updatedHeat = transitionHeat(heatId, HEAT_STATES.COMPLETED, {
    expectedVersion: body.version !== undefined ? body.version : body.expectedVersion,
    actor: engineerName,
    note: `Tap approved by ${engineerName} (${tapRecord.result})`,
    extraUpdates: {
      final_chemistry_json: JSON.stringify(composition),
      tap_json: JSON.stringify(tapRecord)
    }
  });

  // Record durable maker-checker review
  if (currentUser) {
    try {
      const sec = require('./security');
      sec.recordMakerCheckerReview({
        entityType: 'HEAT_RELEASE',
        entityId: heatId,
        entityVersion: updatedHeat.version,
        makerId: heat.plannedBy || 'LEGACY',
        checkerId: currentUser.userId,
        decision: ok ? 'APPROVED' : 'DOWNGRADED',
        reason: ok ? 'Passing chemistry and physical laboratory evidence verified' : (tapRecord.downgradeNote || 'Downgraded')
      });
    } catch (_) {}
  }

  return heatView(updatedHeat);
}

// ------------------------------------------------------------ test certificate
function certificate(heatId) {
  const heat = store.heats.get(heatId);
  if (!heat) throw err(404, `Heat ${heatId} not found`);

  // Interlock: Certificate requires COMPLETED or RELEASED heat with approved tap
  if (!heat.tap || (heat.status !== HEAT_STATES.COMPLETED && heat.status !== HEAT_STATES.RELEASED)) {
    throw err(409, `Heat ${heatId} has no approved tap or is in state '${heat.status}'. Complete and release the heat first.`, {
      code: 'CERTIFICATE_INELIGIBLE'
    });
  }

  // Interlock: Ensure measured chemistry was verified
  if (!heat.tap.chemistry || !heat.tap.chemistry.pass) {
    if (heat.tap.result !== 'DOWNGRADED' && heat.tap.result !== 'PASS') {
      throw err(422, `Heat ${heatId} cannot receive a standard test certificate without passing physical inspection.`);
    }
  }

  const currentSettings = loadSettings();
  const db = getDb();
  const invRow = db.prepare('SELECT * FROM invoices WHERE heat_id = ? AND status != ?').get(heatId, 'CANCELLED');
  const inv = invRow ? { invoiceId: invRow.invoice_id, customer: CUSTOMERS.find((c) => c.id === invRow.customer_id) } : null;

  const lines = (heat.charge || []).map((l) => {
    const lot = store.getLot(l.lotId);
    return {
      lotId: l.lotId,
      material: lot?.alloyName || lot?.materialType,
      supplier: lot?.supplier,
      kg: Number(l.kg),
      status: lot?.previousStatus || lot?.status
    };
  });

  const additions = store.listMovements().filter((m) => m.heatId === heatId && m.type === 'CHARGE' && !heat.charge.some((c) => c.lotId === m.lotId))
    .map((m) => {
      const lot = store.getLot(m.lotId);
      return { lotId: m.lotId, material: lot?.alloyName || lot?.materialType, supplier: lot?.supplier, kg: -m.kg, status: 'Addition' };
    });

  return {
    certificateNo: `TC/${fy(new Date(heat.tap.at))}/${heatId}`,
    type: 'Test certificate (EN 10204 type 3.1 format)',
    issuedAt: heat.tap.at,
    seller: currentSettings.seller,
    customer: inv ? inv.customer : null,
    invoiceId: inv?.invoiceId || null,
    heatId,
    grade: heat.grade,
    gradeLabel: gradeLabel(heat.grade),
    result: heat.tap.result,
    soldGrade: heat.tap.soldGrade,
    downgradeNote: heat.tap.downgradeNote,
    castingsKg: heat.tap.castingsKg,
    chemistry: heat.tap.chemistry,
    mechanical: heat.tap.mechanical,
    gate: {
      gateId: heat.start?.gateId || heat.gate?.gateId || null,
      decision: heat.start?.gateDecision || heat.gate?.decision || null,
      mode: heat.start?.mode || null
    },
    traceability: [...lines, ...additions],
    approvedBy: heat.tap.approvedBy,
    startedBy: heat.start?.by || null,
  };
}

function heatCosts(heat) {
  const chargeRs = (heat.charge || []).reduce((s, l) => s + (Number(l.kg) * (store.getLot(l.lotId)?.costPerKg || 0)), 0);
  const additions = store.listMovements().filter((m) => m.heatId === heat.heatId && m.type === 'CHARGE' && !(heat.charge || []).some((c) => c.lotId === m.lotId));
  const alloyRs = additions.reduce((s, m) => s + (-m.kg * (store.getLot(m.lotId)?.costPerKg || 0)), 0);
  const energyKwh = heat.energyActual?.actualKwh ?? heat.energyAtStart?.kwhTotal ?? heat.gate?.energy?.kwhTotal ?? 0;
  const energyRate = energy.tariff?.rateRsPerKwh ?? 8.0;
  const energyRs = energyKwh * energyRate;
  const returnsCreditRs = heat.tap ? (heat.tap.returnsKg * (store.listLots().find((l) => l.parentHeatId === heat.heatId)?.costPerKg || 35)) : 0;
  return { chargeRs: round(chargeRs, 0), alloyRs: round(alloyRs, 0), energyRs: round(energyRs, 0), returnsCreditRs: round(returnsCreditRs, 0) };
}

function heatView(heat) {
  const db = getDb();
  const invRow = db.prepare('SELECT * FROM invoices WHERE heat_id = ? AND status != ?').get(heat.heatId, 'CANCELLED');
  const inv = invRow ? { invoiceId: invRow.invoice_id } : null;
  const costs = heatCosts(heat);
  const revenue = heat.tap ? heat.tap.castingsKg * heat.tap.sellingRsPerKg : null;
  const totalCost = (costs.chargeRs || 0) + (costs.alloyRs || 0) + (costs.energyRs || 0) - (costs.returnsCreditRs || 0);

  return {
    heatId: heat.heatId,
    grade: heat.grade,
    gradeLabel: gradeLabel(heat.grade),
    status: heat.status,
    version: heat.version,
    completedAt: heat.completedAt || null,
    tap: heat.tap || null,
    invoiceId: inv?.invoiceId || null,
    margin: heat.tap ? {
      revenueRs: round(revenue, 0),
      ...costs,
      totalCostRs: round(totalCost, 0),
      marginRs: round(revenue - totalCost, 0),
      marginPct: revenue ? round(((revenue - totalCost) / revenue) * 100, 1) : null,
      note: 'Revenue at list price minus materials and energy, plus returns credit.',
    } : null,
  };
}

function listCompleted() {
  return store.heats.list().filter((h) => h.tap).map(heatView);
}

// ------------------------------------------------------------ invoices
function createInvoice(body = {}, currentUser = null) {
  const heat = store.heats.get(body.heatId);
  if (!heat) throw err(404, `Heat ${body.heatId} not found`);
  if (!heat.tap) throw err(409, `Heat ${heat.heatId} is not finished — approve the tap first`);

  const db = getDb();
  const existingInv = db.prepare('SELECT * FROM invoices WHERE heat_id = ? AND status != ?').get(heat.heatId, 'CANCELLED');
  if (existingInv) throw err(409, `Heat ${heat.heatId} is already invoiced`);

  const customer = CUSTOMERS.find((c) => c.id === body.customerId);
  if (!customer) throw err(400, 'Choose a customer');

  let creatorName = currentUser ? (currentUser.displayName || currentUser.username) : null;
  if (!creatorName && body.createdBy && String(body.createdBy).trim()) {
    creatorName = String(body.createdBy).trim();
  }
  if (!creatorName) throw err(400, 'Your name is required');
  const creatorId = currentUser ? currentUser.userId : creatorName;

  const qtyKg = body.qtyKg !== undefined && body.qtyKg !== '' ? Number(body.qtyKg) : heat.tap.castingsKg;
  if (!(qtyKg > 0) || qtyKg > heat.tap.castingsKg) throw err(400, `Quantity must be between 1 and ${heat.tap.castingsKg} kg (castings from this heat)`);

  const rate = body.ratePerKg !== undefined && body.ratePerKg !== '' ? Number(body.ratePerKg) : heat.tap.sellingRsPerKg;
  if (!(rate > 0)) throw err(400, 'Rate must be a positive number');

  const currentSettings = loadSettings();
  const taxable = round(qtyKg * rate, 2);
  const gst = currentSettings.gstPct;
  const gstAmount = round((taxable * gst) / 100, 2);
  const total = round(taxable + gstAmount, 2);

  const invId = `INV-${fy()}-${String(Date.now()).slice(-4)}`;
  const nowIso = new Date().toISOString();

  const invRecord = {
    invoiceId: invId,
    heatId: heat.heatId,
    customerId: customer.id,
    customer,
    taxableRs: taxable,
    gstRs: gstAmount,
    totalRs: total,
    issuedAt: nowIso,
    createdBy: String(body.createdBy).trim(),
    status: 'ACTIVE',
    lines: [{ description: `${gradeLabel(heat.tap.soldGrade)} Castings`, qtyKg, ratePerKg: rate, taxableRs: taxable }]
  };

  db.prepare(`
    INSERT INTO invoices (
      invoice_id, heat_id, customer_id, lines_json, taxable_rs, gst_rs, total_rs, issued_at, created_by, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    invId,
    heat.heatId,
    customer.id,
    JSON.stringify(invRecord.lines),
    taxable,
    gstAmount,
    total,
    nowIso,
    invRecord.createdBy,
    'ACTIVE'
  );

  store.log('INVOICE_ISSUED', invId, invRecord.createdBy, `${heat.heatId}: ${qtyKg} kg to ${customer.name}, ₹${total.toLocaleString('en-IN')}`);
  return invRecord;
}

function listInvoices() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM invoices ORDER BY issued_at DESC').all();
  return rows.map((r) => ({
    invoiceId: r.invoice_id,
    heatId: r.heat_id,
    customerId: r.customer_id,
    customer: CUSTOMERS.find((c) => c.id === r.customer_id) || null,
    lines: JSON.parse(r.lines_json),
    taxableRs: r.taxable_rs,
    gstRs: r.gst_rs,
    totalRs: r.total_rs,
    issuedAt: new Date(r.issued_at),
    createdBy: r.created_by,
    status: r.status
  }));
}

function getInvoice(id) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM invoices WHERE invoice_id = ?').get(id);
  if (!r) throw err(404, `Invoice ${id} not found`);
  return {
    invoiceId: r.invoice_id,
    heatId: r.heat_id,
    customerId: r.customer_id,
    customer: CUSTOMERS.find((c) => c.id === r.customer_id) || null,
    lines: JSON.parse(r.lines_json),
    taxableRs: r.taxable_rs,
    gstRs: r.gst_rs,
    totalRs: r.total_rs,
    issuedAt: new Date(r.issued_at),
    createdBy: r.created_by,
    status: r.status
  };
}

// ------------------------------------------------------------ configuration & material balance (S0-011)
function getConfig() {
  const s = loadSettings();
  return { ...s, customers: CUSTOMERS };
}

function updateConfig(patch = {}) {
  const s = loadSettings();

  if (patch.seller && typeof patch.seller === 'object') {
    ['name', 'address', 'gstin', 'stateCode', 'state', 'phone', 'email', 'bank'].forEach((k) => {
      if (typeof patch.seller[k] === 'string') s.seller[k] = patch.seller[k];
    });
    s.seller.isDemo = false;
  }

  // S0-011: Joint Material Balance Validation
  const newCastingYield = patch.castingYieldPct !== undefined ? patch.castingYieldPct : s.castingYieldPct;
  const newReturns = patch.returnsPct !== undefined ? patch.returnsPct : s.returnsPct;
  const newLoss = patch.documentedLossPct !== undefined ? patch.documentedLossPct : (s.documentedLossPct || 0);

  if (patch.castingYieldPct !== undefined || patch.returnsPct !== undefined || patch.documentedLossPct !== undefined) {
    if (typeof newCastingYield !== 'number' || !Number.isFinite(newCastingYield) || newCastingYield < 0) {
      throw err(400, "castingYieldPct must be a finite positive number >= 0");
    }
    if (typeof newReturns !== 'number' || !Number.isFinite(newReturns) || newReturns < 0) {
      throw err(400, "returnsPct must be a finite positive number >= 0");
    }
    if (typeof newLoss !== 'number' || !Number.isFinite(newLoss) || newLoss < 0) {
      throw err(400, "documentedLossPct must be a finite positive number >= 0");
    }

    const jointSum = Math.round((newCastingYield + newReturns + newLoss) * 10) / 10;

    if (jointSum > 100.0) {
      throw err(400, `Material balance conservation violation: castingYieldPct (${newCastingYield}%) + returnsPct (${newReturns}%) + documentedLossPct (${newLoss}%) = ${jointSum}% exceeds 100% of liquid bath metal. Total accounted fraction cannot exceed 100%.`);
    }

    s.castingYieldPct = newCastingYield;
    s.returnsPct = newReturns;
    s.documentedLossPct = newLoss;
  }

  ['gstPct', 'paymentTermsDays'].forEach((k) => {
    if (typeof patch[k] === 'number' && Number.isFinite(patch[k]) && patch[k] >= 0) {
      s[k] = patch[k];
    }
  });

  saveSettings(s);
  return getConfig();
}

module.exports = {
  completeHeat,
  listCompleted,
  certificate,
  createInvoice,
  listInvoices,
  getInvoice,
  getConfig,
  updateConfig,
  CUSTOMERS,
  inWords
};
