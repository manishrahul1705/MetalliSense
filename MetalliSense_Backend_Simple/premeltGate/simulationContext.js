// A store has one immutable evidence context. Request data never selects it.
const path = require('node:path');
const TABLES = ['lots', 'qa_results', 'heats', 'evidence', 'movements',
  'maker_checker_reviews', 'heat_transitions', 'invoices', 'instrument_readings', 'idempotency_receipts', 'simulation_artifacts', 'correction_candidates'];

function configuredContext(targetPath) {
  if (process.env.METALLISENSE_SIMULATION !== 'true') return 'OPERATIONAL';
  if (!['test', 'development'].includes(process.env.NODE_ENV)
      || !process.env.METALLISENSE_DB_PATH
      || !process.env.METALLISENSE_SIMULATION_STORE
      || path.resolve(targetPath) !== path.resolve(process.env.METALLISENSE_SIMULATION_STORE)) {
    throw new Error('SIMULATION_STORE_REQUIRED: simulation requires an explicit isolated database in test/development');
  }
  return 'SIMULATION';
}

function bindStore(db, context) {
  db.exec('BEGIN IMMEDIATE');
  try {
  db.exec(`CREATE TABLE IF NOT EXISTS simulation_artifacts (
    artifact_id TEXT PRIMARY KEY, heat_id TEXT NOT NULL REFERENCES heats(heat_id),
    kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(heat_id, kind))`);
  db.exec(`CREATE TABLE IF NOT EXISTS correction_candidates (
    candidate_id TEXT PRIMARY KEY, heat_id TEXT NOT NULL REFERENCES heats(heat_id),
    maker_id TEXT NOT NULL, heat_version INTEGER NOT NULL, evidence_version TEXT NOT NULL,
    candidate_hash TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS store_context (id INTEGER PRIMARY KEY CHECK(id = 1), context TEXT NOT NULL)');
  const saved = db.prepare('SELECT context FROM store_context WHERE id = 1').get();
  if (saved && saved.context !== context) throw new Error('STORE_CONTEXT_MISMATCH: database context cannot change');
  if (!saved) {
    // An existing operational store cannot be adopted by a simulation process.
    if (context === 'SIMULATION' && TABLES.some(t => db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())) {
      throw new Error('SIMULATION_STORE_NOT_EMPTY: use a new isolated store');
    }
    db.prepare('INSERT INTO store_context VALUES (1, ?)').run(context);
    db.exec(`CREATE TRIGGER store_context_no_update BEFORE UPDATE ON store_context BEGIN SELECT RAISE(ABORT, 'immutable store context'); END;
      CREATE TRIGGER store_context_no_delete BEFORE DELETE ON store_context BEGIN SELECT RAISE(ABORT, 'immutable store context'); END;`);
  }
  for (const table of TABLES) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'execution_context')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN execution_context TEXT NOT NULL DEFAULT '${context}' CHECK(execution_context = '${context}');`);
    }
  }
  db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function context(db) {
  return db.prepare('SELECT context FROM store_context WHERE id = 1').get().context;
}

module.exports = { configuredContext, bindStore, context };
