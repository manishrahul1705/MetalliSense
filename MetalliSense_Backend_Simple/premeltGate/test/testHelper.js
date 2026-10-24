/**
 * Test Helper for MetalliSense Stage 1A Test Suite
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// Ensure external dependencies from outside repo are available without polluting source repo
const externalModulesPath = 'C:\\Users\\Manish\\Downloads\\MetalliSense-COMPLETE-FINAL\\MetalliSense_Backend_Simple\\node_modules';
if (fs.existsSync(externalModulesPath)) {
  if (!module.paths.includes(externalModulesPath)) {
    module.paths.push(externalModulesPath);
  }
  const Module = require('module');
  if (Module.globalPaths && !Module.globalPaths.includes(externalModulesPath)) {
    Module.globalPaths.push(externalModulesPath);
  }
}

// Set an isolated test DB path before requiring db / store
const testDbDir = path.join(os.tmpdir(), 'metallisense-stage1a-test');
if (!fs.existsSync(testDbDir)) {
  fs.mkdirSync(testDbDir, { recursive: true });
}
const testDbPath = path.join(testDbDir, `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
process.env.METALLISENSE_DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.ENABLE_DEMO_RESET = 'true';

const { getDb, closeDb, withTransaction } = require('../db');
const store = require('../store');
const heatStateMachine = require('../heatStateMachine');
const evidenceEngine = require('../evidenceEngine');
const inventoryLedger = require('../inventoryLedger');
const sales = require('../sales');

function initTestDb() {
  // Ensure DB schema and seed
  store.seed(true);
}

function createMeltingHeat(heatId = 'H-TEST-MELTING', targetKg = 1000) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM heats WHERE heat_id = ?').get(heatId);
  if (existing) {
    db.prepare('DELETE FROM heats WHERE heat_id = ?').run(heatId);
    db.prepare('DELETE FROM heat_transitions WHERE heat_id = ?').run(heatId);
  }
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO heats (
      heat_id, grade, target_kg, status, version, charge_json, planned_by,
      created_at, updated_at
    ) VALUES (?, 'SG-IRON', ?, 'MELTING', 1, '[]', 'tester', ?, ?)
  `).run(heatId, targetKg, nowIso, nowIso);
  return store.heats.get(heatId);
}

module.exports = {
  testDbPath,
  testDbDir,
  getDb,
  closeDb,
  withTransaction,
  store,
  heatStateMachine,
  evidenceEngine,
  inventoryLedger,
  sales,
  initTestDb,
  createMeltingHeat
};
