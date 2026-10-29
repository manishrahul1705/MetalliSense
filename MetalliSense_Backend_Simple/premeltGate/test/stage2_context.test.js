const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metallisense-stage2-context-'));
const dbFile = path.join(dir, 'simulation.db');
process.env.NODE_ENV = 'test';
process.env.METALLISENSE_DB_PATH = dbFile;
process.env.METALLISENSE_SIMULATION = 'true';
delete process.env.METALLISENSE_SIMULATION_STORE;
const storage = require('../db');
assert.throws(() => storage.initDb(), /SIMULATION_STORE_REQUIRED/);
process.env.METALLISENSE_SIMULATION_STORE = dbFile;
const db = storage.initDb();
assert.equal(require('../simulationContext').context(db), 'SIMULATION');
const store = require('../store');
require('../routes');
const seededVersion = store.getLot('SCR-0912').version;
const seededSessions = store.sessions.list('SCR-0912').length;
delete require.cache[require.resolve('../routes')];
require('../routes');
assert.equal(store.getLot('SCR-0912').version, seededVersion, 'Startup must not reapply a durable inspection');
assert.equal(store.sessions.list('SCR-0912').length, seededSessions);
const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [], plannedBy: 'fixture' });
assert.equal(heat.executionContext, 'SIMULATION');
assert.throws(() => db.prepare("UPDATE heats SET execution_context = 'OPERATIONAL' WHERE heat_id = ?").run(heat.heatId), /CHECK constraint/);
assert.throws(() => db.exec("UPDATE store_context SET context = 'OPERATIONAL'"), /immutable/);
storage.closeDb();
assert.equal(storage.initDb().prepare('SELECT execution_context FROM heats WHERE heat_id = ?').get(heat.heatId).execution_context, 'SIMULATION');
storage.closeDb();
delete process.env.METALLISENSE_SIMULATION;
assert.throws(() => storage.initDb(), /STORE_CONTEXT_MISMATCH/);
const operational = path.join(dir, 'operational.db');
process.env.METALLISENSE_DB_PATH = operational;
let opDb = storage.initDb();
assert.equal(require('../simulationContext').context(opDb), 'OPERATIONAL');
assert.throws(() => opDb.prepare("INSERT INTO maker_checker_reviews (review_id, entity_type, entity_id, entity_version, maker_id, checker_id, decision, reason, reviewed_at, execution_context) VALUES ('cross', 'ALLOY_CORRECTION', 'heat', 1, 'maker', 'checker', 'APPROVED', 'simulated', '2026-10-29', 'SIMULATION')").run(), /CHECK constraint/);
assert.equal(opDb.prepare('SELECT count(*) AS n FROM maker_checker_reviews').get().n, 0);
storage.closeDb();
process.env.METALLISENSE_SIMULATION = 'true';
process.env.METALLISENSE_SIMULATION_STORE = operational;
assert.throws(() => storage.initDb(), /STORE_CONTEXT_MISMATCH/);
process.env.NODE_ENV = 'production';
assert.throws(() => storage.initDb(), /SIMULATION_STORE_REQUIRED/);
// A separate operational process also refuses the simulation database.
const child = spawnSync(process.execPath, ['-e', "require('./premeltGate/db').initDb()"], {
  cwd: path.resolve(__dirname, '../..'),
  env: { ...process.env, NODE_ENV: 'test', METALLISENSE_SIMULATION: 'false', METALLISENSE_DB_PATH: dbFile },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
assert.notEqual(child.status, 0);
assert.match(child.stderr, /STORE_CONTEXT_MISMATCH/);
console.log('PASS: explicit isolated configuration, production rejection, immutable store/heat context, cross-context approval rejection and process reopen');
console.log(`Retained boundary stores: ${dir}`);
