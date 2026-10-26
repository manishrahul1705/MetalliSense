/**
 * Durable transactional SQLite storage for Pre-Melt Gate and MetalliSense Core.
 * Uses Node.js v22+ built-in node:sqlite (DatabaseSync) with zero external dependencies.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

let currentDb = null;
let currentDbPath = null;

function getDefaultDbPath() {
  if (process.env.METALLISENSE_DB_PATH) {
    return process.env.METALLISENSE_DB_PATH;
  }
  // Safe default outside repo source directory to preserve git cleanliness
  const baseDir = path.join(os.tmpdir(), 'metallisense-data');
  return path.join(baseDir, 'metallisense.db');
}

function initDb(dbPath = null) {
  const targetPath = dbPath || getDefaultDbPath();
  
  if (currentDb && currentDbPath === targetPath) {
    return currentDb;
  }

  if (targetPath !== ':memory:') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  try {
    currentDb = new DatabaseSync(targetPath);
    currentDbPath = targetPath;
  } catch (err) {
    throw new Error(`CRITICAL_STORAGE_INIT_FAILURE: Unable to initialize SQLite database at '${targetPath}': ${err.message}`);
  }

  // Enforce WAL, foreign keys, synchronous NORMAL
  currentDb.exec('PRAGMA foreign_keys = ON;');
  if (targetPath !== ':memory:') {
    currentDb.exec('PRAGMA journal_mode = WAL;');
  }
  currentDb.exec('PRAGMA synchronous = NORMAL;');

  runMigrations(currentDb);
  if (canBootstrapDevAccounts()) {
    bootstrapDevAccounts(currentDb);
  }
  return currentDb;
}

function getDb() {
  if (!currentDb) {
    return initDb();
  }
  return currentDb;
}

function closeDb() {
  if (currentDb) {
    try {
      currentDb.close();
    } catch (_) {}
    currentDb = null;
    currentDbPath = null;
  }
}

// -----------------------------------------------------------------------------
// Transaction helper
// -----------------------------------------------------------------------------
let inTransaction = false;

function withTransaction(fn, dbInstance = null) {
  const db = dbInstance || getDb();
  if (inTransaction) {
    return fn(db);
  }
  inTransaction = true;
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    inTransaction = false;
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch (_) {}
    inTransaction = false;
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Versioned Schema Migrations
// -----------------------------------------------------------------------------
const MIGRATIONS = [
  {
    version: 1,
    name: '001_core_durable_schema',
    up(db) {
      db.exec(`
        -- Heats
        CREATE TABLE IF NOT EXISTS heats (
          heat_id TEXT PRIMARY KEY,
          grade TEXT NOT NULL,
          target_kg REAL NOT NULL,
          status TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          charge_json TEXT NOT NULL,
          planned_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          gate_json TEXT,
          gate_history_json TEXT,
          start_json TEXT,
          energy_at_start_json TEXT,
          final_chemistry_json TEXT,
          tap_json TEXT
        );

        -- Heat state transition log (append-only)
        CREATE TABLE IF NOT EXISTS heat_transitions (
          event_id TEXT PRIMARY KEY,
          heat_id TEXT NOT NULL REFERENCES heats(heat_id) ON DELETE RESTRICT,
          prev_state TEXT NOT NULL,
          new_state TEXT NOT NULL,
          version INTEGER NOT NULL,
          actor TEXT,
          at TEXT NOT NULL,
          note TEXT
        );

        -- Raw material & additive lots
        CREATE TABLE IF NOT EXISTS lots (
          lot_id TEXT PRIMARY KEY,
          material_type TEXT NOT NULL,
          description TEXT,
          alloy_name TEXT,
          supplier TEXT,
          truck_no TEXT,
          grn_no TEXT,
          bay TEXT,
          received_at TEXT NOT NULL,
          received_kg REAL NOT NULL,
          cost_per_kg REAL NOT NULL,
          declared_json TEXT,
          tested_json TEXT,
          chemistry_source TEXT,
          status TEXT NOT NULL,
          status_reason TEXT,
          restriction_json TEXT,
          flags_json TEXT,
          storage_json TEXT,
          promised_at TEXT,
          invoice_kg REAL,
          docs_json TEXT,
          parent_heat_id TEXT,
          simulation_json TEXT,
          qa_ids_json TEXT,
          session_ids_json TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          previous_status TEXT,
          decided_by TEXT
        );

        -- Stock ledger movements (append-only)
        CREATE TABLE IF NOT EXISTS movements (
          id TEXT PRIMARY KEY,
          lot_id TEXT NOT NULL REFERENCES lots(lot_id) ON DELETE RESTRICT,
          type TEXT NOT NULL,
          kg_scaled INTEGER NOT NULL,
          kg REAL NOT NULL,
          heat_id TEXT,
          by TEXT,
          note TEXT,
          at TEXT NOT NULL
        );

        -- Idempotency receipts
        CREATE TABLE IF NOT EXISTS idempotency_receipts (
          idempotency_key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        -- Evidence repository (chemistry and mechanical measurements)
        CREATE TABLE IF NOT EXISTS evidence (
          evidence_id TEXT PRIMARY KEY,
          heat_id TEXT NOT NULL REFERENCES heats(heat_id) ON DELETE RESTRICT,
          evidence_type TEXT NOT NULL,
          values_json TEXT NOT NULL,
          source_instrument TEXT,
          units TEXT,
          provenance TEXT NOT NULL,
          spec_version TEXT NOT NULL,
          actor TEXT,
          created_at TEXT NOT NULL,
          is_valid INTEGER NOT NULL DEFAULT 1
        );

        -- QA laboratory results (DRI, etc.)
        CREATE TABLE IF NOT EXISTS qa_results (
          qa_id TEXT PRIMARY KEY,
          lot_id TEXT NOT NULL REFERENCES lots(lot_id) ON DELETE RESTRICT,
          sample_id TEXT,
          sampled_at TEXT,
          tested_at TEXT,
          values_json TEXT,
          method TEXT,
          analyst TEXT,
          status TEXT,
          approved_by TEXT,
          approved_at TEXT,
          entered_at TEXT,
          calculated_json TEXT,
          version INTEGER DEFAULT 1
        );

        -- Handheld gun sessions
        CREATE TABLE IF NOT EXISTS gun_sessions (
          session_id TEXT PRIMARY KEY,
          lot_id TEXT,
          started_at TEXT,
          completed_at TEXT,
          session_data_json TEXT
        );

        -- Sales settings (singleton)
        CREATE TABLE IF NOT EXISTS sales_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          settings_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Invoices
        CREATE TABLE IF NOT EXISTS invoices (
          invoice_id TEXT PRIMARY KEY,
          heat_id TEXT NOT NULL REFERENCES heats(heat_id) ON DELETE RESTRICT,
          customer_id TEXT NOT NULL,
          lines_json TEXT NOT NULL,
          taxable_rs REAL NOT NULL,
          gst_rs REAL NOT NULL,
          total_rs REAL NOT NULL,
          issued_at TEXT NOT NULL,
          created_by TEXT,
          status TEXT NOT NULL DEFAULT 'ACTIVE'
        );

        -- Regulatory compliance audit trail (NEVER TRUNCATED)
        CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          ref TEXT,
          by TEXT,
          detail TEXT
        );

        -- Persistent monotonic sequence counters
        CREATE TABLE IF NOT EXISTS counters (
          key TEXT PRIMARY KEY,
          val INTEGER NOT NULL DEFAULT 0
        );

        -- Indexes for high-frequency queries
        CREATE INDEX IF NOT EXISTS idx_movements_lot ON movements(lot_id);
        CREATE INDEX IF NOT EXISTS idx_movements_heat ON movements(heat_id);
        CREATE INDEX IF NOT EXISTS idx_transitions_heat ON heat_transitions(heat_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_heat ON evidence(heat_id);
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(id DESC);
      `);
    }
  },
  {
    version: 2,
    name: '002_security_identities_and_rbac',
    up(db) {
      db.exec(`
        -- Users
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          email TEXT UNIQUE NOT NULL,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          roles TEXT NOT NULL,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          credential_version INTEGER NOT NULL DEFAULT 1,
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT,
          revoked_before TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT
        );

        -- Machine Service Credentials
        CREATE TABLE IF NOT EXISTS service_credentials (
          service_id TEXT PRIMARY KEY,
          service_name TEXT NOT NULL,
          service_type TEXT NOT NULL,
          api_key_hash TEXT NOT NULL,
          allowed_sources TEXT NOT NULL,
          permitted_evidence TEXT NOT NULL,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          credential_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          last_auth_at TEXT
        );

        -- Sessions
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          credential_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          is_revoked INTEGER NOT NULL DEFAULT 0,
          ip_address TEXT,
          user_agent TEXT
        );

        -- Maker-Checker Reviews
        CREATE TABLE IF NOT EXISTS maker_checker_reviews (
          review_id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          entity_version INTEGER NOT NULL,
          maker_id TEXT NOT NULL,
          checker_id TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason TEXT NOT NULL,
          reviewed_at TEXT NOT NULL,
          is_superseded INTEGER NOT NULL DEFAULT 0
        );

        -- Security Events Audit Log
        CREATE TABLE IF NOT EXISTS security_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor_id TEXT,
          actor_type TEXT,
          ip TEXT,
          detail TEXT
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(session_id, is_revoked, expires_at);
        CREATE INDEX IF NOT EXISTS idx_security_events_at ON security_events(id DESC);
        CREATE INDEX IF NOT EXISTS idx_maker_checker_entity ON maker_checker_reviews(entity_type, entity_id);
      `);

      // Add columns to evidence if they do not exist
      try { db.exec('ALTER TABLE evidence ADD COLUMN sample_id TEXT;'); } catch (_) {}
      try { db.exec('ALTER TABLE evidence ADD COLUMN payload_hash TEXT;'); } catch (_) {}
      try { db.exec('ALTER TABLE evidence ADD COLUMN ingested_by_service TEXT;'); } catch (_) {}

      // Add columns to maker_checker_reviews for version-bound candidate approval and deduction consumption
      try { db.exec('ALTER TABLE maker_checker_reviews ADD COLUMN candidate_hash TEXT;'); } catch (_) {}
      try { db.exec('ALTER TABLE maker_checker_reviews ADD COLUMN candidate_id TEXT;'); } catch (_) {}
      try { db.exec('ALTER TABLE maker_checker_reviews ADD COLUMN additions_json TEXT;'); } catch (_) {}
      try { db.exec('ALTER TABLE maker_checker_reviews ADD COLUMN evidence_version TEXT;'); } catch (_) {}
      try { db.exec('ALTER TABLE maker_checker_reviews ADD COLUMN spec_version TEXT;'); } catch (_) {}
      try { db.exec('ALTER TABLE maker_checker_reviews ADD COLUMN is_consumed INTEGER DEFAULT 0;'); } catch (_) {}
      try { db.exec('ALTER TABLE maker_checker_reviews ADD COLUMN consumed_at TEXT;'); } catch (_) {}
      try { db.exec('ALTER TABLE maker_checker_reviews ADD COLUMN consumed_by TEXT;'); } catch (_) {}
    }
  }
];

function canBootstrapDevAccounts() {
  const env = (process.env.NODE_ENV || '').trim();
  const isProd = env === 'production';
  const isDevOrTest = env === 'development' || env === 'test';
  const isExplicitBootstrap = process.env.SEED_DEV_ACCOUNTS === 'true' || process.env.ALLOW_DEV_BOOTSTRAP === 'true';

  // SEC-FINDING-001 Policy Enforcement:
  // 1. Prohibit development-account seeding in production under all circumstances, even when flag is true
  if (isProd) return false;
  // 2. No automatic account seeding when NODE_ENV is unset
  if (!env) return false;
  // 3. Require explicit development/test bootstrap
  return isDevOrTest && isExplicitBootstrap;
}

function bootstrapDevAccounts(targetDb = null, credentials = {}) {
  const db = targetDb || getDb();
  if (!canBootstrapDevAccounts() && !credentials.forceBootstrap) {
    return { seeded: false, reason: 'BOOTSTRAP_DISALLOWED' };
  }

  const existingUsers = db.prepare('SELECT count(*) as c FROM users').get();
  if (existingUsers && existingUsers.c > 0) {
    return { seeded: false, reason: 'USERS_ALREADY_EXIST' };
  }

  const crypto = require('crypto');
  function quickScrypt(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
    return 'scrypt$16384$8$1$' + salt + '$' + derived;
  }

  // Isolated test provisioning without committed working credentials
  const isTest = process.env.NODE_ENV === 'test';
  const creds = {
    operator: credentials.operatorPassword || process.env.DEV_OPERATOR_PASSWORD || (isTest ? 'OperatorPass123!' : null),
    metallurgist: credentials.metallurgistPassword || process.env.DEV_METALLURGIST_PASSWORD || (isTest ? 'MetallurgyPass123!' : null),
    qm: credentials.qmPassword || process.env.DEV_QM_PASSWORD || (isTest ? 'QualityPass123!' : null),
    inventory: credentials.inventoryPassword || process.env.DEV_INVENTORY_PASSWORD || (isTest ? 'InventoryPass123!' : null),
    finance: credentials.financePassword || process.env.DEV_FINANCE_PASSWORD || (isTest ? 'FinancePass123!' : null),
    admin: credentials.adminPassword || process.env.DEV_ADMIN_PASSWORD || (isTest ? 'AdminSecurePass123!' : null),
    spectroToken: credentials.spectroToken || process.env.DEV_SPECTRO_TOKEN || (isTest ? 'spectro-dev-token-secret-2026' : null),
    labToken: credentials.labToken || process.env.DEV_LAB_TOKEN || (isTest ? 'lab-dev-token-secret-2026' : null),
  };

  // If in dev and no password provided via env, generate cryptographically secure ephemeral passwords
  Object.keys(creds).forEach((k) => {
    if (!creds[k]) {
      creds[k] = crypto.randomBytes(16).toString('base64url') + '!1Aa';
    }
  });

  const now = new Date().toISOString();
  withTransaction((txDb) => {
    const insertUser = txDb.prepare(`
      INSERT OR IGNORE INTO users (user_id, username, email, display_name, password_hash, roles, is_enabled, credential_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `);

    insertUser.run('USR-OP-01', 'operator1', 'operator1@example.com', 'Rajesh Operator', quickScrypt(creds.operator), JSON.stringify(['OPERATOR']), now, now);
    insertUser.run('USR-MET-01', 'metallurgist1', 'metallurgist1@example.com', 'Dr. Aris Metallurgist', quickScrypt(creds.metallurgist), JSON.stringify(['METALLURGIST']), now, now);
    insertUser.run('USR-QM-01', 'qm1', 'qm1@example.com', 'Priya Quality Mgr', quickScrypt(creds.qm), JSON.stringify(['QUALITY_MANAGER']), now, now);
    insertUser.run('USR-INV-01', 'inventory1', 'inventory1@example.com', 'Suresh Stores', quickScrypt(creds.inventory), JSON.stringify(['INVENTORY_CONTROLLER']), now, now);
    insertUser.run('USR-FIN-01', 'finance1', 'finance1@example.com', 'Anand Finance', quickScrypt(creds.finance), JSON.stringify(['SALES_FINANCE']), now, now);
    insertUser.run('USR-ADM-01', 'admin1', 'admin1@example.com', 'Systems Administrator', quickScrypt(creds.admin), JSON.stringify(['ADMIN']), now, now);

    // Seed service credentials
    const insertSvc = txDb.prepare(`
      INSERT OR IGNORE INTO service_credentials (service_id, service_name, service_type, api_key_hash, allowed_sources, permitted_evidence, is_enabled, credential_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
    `);

    const spectroHash = crypto.createHash('sha256').update(creds.spectroToken).digest('hex');
    insertSvc.run('SVC-SPECTRO-01', 'Optical Emission Spectrometer', 'SPECTROMETER_SERVICE', spectroHash, JSON.stringify(['OES-01', 'OES-02', 'SPECTRO-LAB']), JSON.stringify(['MELT_MEASURED', 'POST_CORRECTION_MEASURED']), now);

    const labHash = crypto.createHash('sha256').update(creds.labToken).digest('hex');
    insertSvc.run('SVC-LAB-01', 'Physical Testing Laboratory', 'LAB_SERVICE', labHash, JSON.stringify(['UTM-01', 'IMPACT-01', 'HARDNESS-01']), JSON.stringify(['LAB_MEASURED']), now);
  }, db);

  return { seeded: true, usersSeeded: 6, servicesSeeded: 2 };
}

function runMigrations(targetDb = null) {
  const db = targetDb || getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  // Verify no migration version rollback / unsupported version
  const maxApplied = appliedRows.length ? Math.max(...appliedRows.map((r) => r.version)) : 0;
  const maxSupported = Math.max(...MIGRATIONS.map((m) => m.version));
  if (maxApplied > maxSupported) {
    throw new Error(`UNSUPPORTED_SCHEMA_VERSION: Database schema version ${maxApplied} is newer than supported version ${maxSupported}.`);
  }

  let appliedCount = 0;
  for (const m of MIGRATIONS) {
    if (!appliedSet.has(m.version)) {
      withTransaction((txDb) => {
        m.up(txDb);
        txDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, new Date().toISOString());
      }, db);
      appliedCount++;
    }
  }

  const updatedRows = db.prepare('SELECT version FROM schema_migrations').all();
  const currentVersion = updatedRows.length ? Math.max(...updatedRows.map((r) => r.version)) : 0;

  return {
    applied: appliedCount,
    currentVersion
  };
}

module.exports = {
  initDb,
  getDb,
  closeDb,
  withTransaction,
  runMigrations,
  getDefaultDbPath,
  canBootstrapDevAccounts,
  bootstrapDevAccounts
};
