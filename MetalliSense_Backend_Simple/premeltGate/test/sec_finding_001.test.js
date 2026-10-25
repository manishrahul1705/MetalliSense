/**
 * Targeted verification for SEC-FINDING-001 Remediation
 *
 * Rules verified:
 * 1. No automatic account seeding when NODE_ENV is unset.
 * 2. Require explicit development/test bootstrap (NODE_ENV=dev/test AND flag=true).
 * 3. Prohibit development-account seeding in production, even when the flag is true.
 * 4. Isolated test provisioning without committed working credentials.
 * 5. All environment/flag combinations and existing-session regressions.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  initDb,
  closeDb,
  canBootstrapDevAccounts,
  bootstrapDevAccounts
} = require('../db');

function createTempDb() {
  const tmpPath = path.join(__dirname, `sec_finding_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
  return {
    path: tmpPath,
    cleanup: () => {
      try { closeDb(); } catch (_) {}
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    }
  };
}

async function runTests() {
  console.log('=== Running SEC-FINDING-001 Security Test Matrix ===\n');

  const originalEnv = { ...process.env };

  try {
    // -------------------------------------------------------------------------
    // Test 1: NODE_ENV unset, SEED_DEV_ACCOUNTS unset -> NO SEED
    // -------------------------------------------------------------------------
    delete process.env.NODE_ENV;
    delete process.env.SEED_DEV_ACCOUNTS;
    delete process.env.ALLOW_DEV_BOOTSTRAP;
    assert.strictEqual(canBootstrapDevAccounts(), false, 'Unset NODE_ENV must evaluate canBootstrap to false');

    const db1 = createTempDb();
    const instance1 = initDb(db1.path);
    const users1 = instance1.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users1.c, 0, 'Unset NODE_ENV must NOT seed any users into database');
    db1.cleanup();
    console.log('[PASS] Test 1: NODE_ENV unset, flag unset -> zero accounts seeded');

    // -------------------------------------------------------------------------
    // Test 2: NODE_ENV unset, SEED_DEV_ACCOUNTS=true -> NO SEED (Fail-closed)
    // -------------------------------------------------------------------------
    delete process.env.NODE_ENV;
    process.env.SEED_DEV_ACCOUNTS = 'true';
    assert.strictEqual(canBootstrapDevAccounts(), false, 'Unset NODE_ENV with flag=true must evaluate canBootstrap to false');

    const db2 = createTempDb();
    const instance2 = initDb(db2.path);
    const users2 = instance2.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users2.c, 0, 'Unset NODE_ENV with flag=true must NOT seed any users');
    db2.cleanup();
    console.log('[PASS] Test 2: NODE_ENV unset, flag=true -> fail-closed (zero accounts seeded)');

    // -------------------------------------------------------------------------
    // Test 3: NODE_ENV=production, SEED_DEV_ACCOUNTS unset -> NO SEED
    // -------------------------------------------------------------------------
    process.env.NODE_ENV = 'production';
    delete process.env.SEED_DEV_ACCOUNTS;
    assert.strictEqual(canBootstrapDevAccounts(), false, 'Production environment must evaluate canBootstrap to false');

    const db3 = createTempDb();
    const instance3 = initDb(db3.path);
    const users3 = instance3.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users3.c, 0, 'Production must NOT seed users');
    db3.cleanup();
    console.log('[PASS] Test 3: NODE_ENV=production, flag unset -> zero accounts seeded');

    // -------------------------------------------------------------------------
    // Test 4: NODE_ENV=production, SEED_DEV_ACCOUNTS=true -> PROHIBITED (Strict Prohibition)
    // -------------------------------------------------------------------------
    process.env.NODE_ENV = 'production';
    process.env.SEED_DEV_ACCOUNTS = 'true';
    assert.strictEqual(canBootstrapDevAccounts(), false, 'Production with flag=true MUST be prohibited from seeding accounts');

    const db4 = createTempDb();
    const instance4 = initDb(db4.path);
    const users4 = instance4.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users4.c, 0, 'Production with flag=true must NOT seed development accounts');
    db4.cleanup();
    console.log('[PASS] Test 4: NODE_ENV=production, flag=true -> strictly prohibited');

    // -------------------------------------------------------------------------
    // Test 5: NODE_ENV=staging, SEED_DEV_ACCOUNTS=true -> PROHIBITED
    // -------------------------------------------------------------------------
    process.env.NODE_ENV = 'staging';
    process.env.SEED_DEV_ACCOUNTS = 'true';
    assert.strictEqual(canBootstrapDevAccounts(), false, 'Staging must NOT permit development seeding');

    const db5 = createTempDb();
    const instance5 = initDb(db5.path);
    const users5 = instance5.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users5.c, 0, 'Staging with flag=true must NOT seed');
    db5.cleanup();
    console.log('[PASS] Test 5: NODE_ENV=staging, flag=true -> prohibited');

    // -------------------------------------------------------------------------
    // Test 6: NODE_ENV=development, SEED_DEV_ACCOUNTS unset -> NO SEED
    // -------------------------------------------------------------------------
    process.env.NODE_ENV = 'development';
    delete process.env.SEED_DEV_ACCOUNTS;
    assert.strictEqual(canBootstrapDevAccounts(), false, 'Development without explicit bootstrap flag must NOT seed');

    const db6 = createTempDb();
    const instance6 = initDb(db6.path);
    const users6 = instance6.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users6.c, 0, 'Development without flag must NOT seed');
    db6.cleanup();
    console.log('[PASS] Test 6: NODE_ENV=development, flag unset -> require explicit bootstrap');

    // -------------------------------------------------------------------------
    // Test 7: NODE_ENV=development, SEED_DEV_ACCOUNTS=true -> SEED ALLOWED
    // -------------------------------------------------------------------------
    process.env.NODE_ENV = 'development';
    process.env.SEED_DEV_ACCOUNTS = 'true';
    assert.strictEqual(canBootstrapDevAccounts(), true, 'Development with explicit bootstrap flag MUST allow seeding');

    const db7 = createTempDb();
    const instance7 = initDb(db7.path);
    const users7 = instance7.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users7.c, 6, 'Development with flag=true must seed exactly 6 development users');
    db7.cleanup();
    console.log('[PASS] Test 7: NODE_ENV=development, flag=true -> accounts bootstrapped');

    // -------------------------------------------------------------------------
    // Test 8: NODE_ENV=test, SEED_DEV_ACCOUNTS unset -> NO SEED
    // -------------------------------------------------------------------------
    process.env.NODE_ENV = 'test';
    delete process.env.SEED_DEV_ACCOUNTS;
    assert.strictEqual(canBootstrapDevAccounts(), false, 'Test mode without explicit flag must NOT auto-seed');

    const db8 = createTempDb();
    const instance8 = initDb(db8.path);
    const users8 = instance8.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users8.c, 0, 'Test mode without flag must NOT seed');
    db8.cleanup();
    console.log('[PASS] Test 8: NODE_ENV=test, flag unset -> zero accounts seeded');

    // -------------------------------------------------------------------------
    // Test 9: NODE_ENV=test, SEED_DEV_ACCOUNTS=true -> SEED ALLOWED
    // -------------------------------------------------------------------------
    process.env.NODE_ENV = 'test';
    process.env.SEED_DEV_ACCOUNTS = 'true';
    assert.strictEqual(canBootstrapDevAccounts(), true, 'Test mode with explicit flag MUST allow seeding');

    const db9 = createTempDb();
    const instance9 = initDb(db9.path);
    const users9 = instance9.prepare('SELECT count(*) as c FROM users').get();
    assert.strictEqual(users9.c, 6, 'Test mode with flag=true must seed exactly 6 development users');
    const svcs9 = instance9.prepare('SELECT count(*) as c FROM service_credentials').get();
    assert.strictEqual(svcs9.c, 2, 'Test mode with flag=true must seed exactly 2 service credentials');
    db9.cleanup();
    console.log('[PASS] Test 9: NODE_ENV=test, flag=true -> accounts bootstrapped');

    // -------------------------------------------------------------------------
    // Test 10: Existing Session & User Regression Test
    // -------------------------------------------------------------------------
    process.env.NODE_ENV = 'test';
    process.env.SEED_DEV_ACCOUNTS = 'true';
    const db10 = createTempDb();
    const instance10A = initDb(db10.path);

    // Verify initial users
    const opUserPre = instance10A.prepare("SELECT * FROM users WHERE username = 'operator1'").get();
    assert.ok(opUserPre, 'operator1 must exist');
    assert.strictEqual(opUserPre.credential_version, 1, 'credential_version must be 1');

    // Insert an active session
    const sessionId = 'test-session-regression-001';
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    instance10A.prepare(`
      INSERT INTO sessions (session_id, user_id, credential_version, created_at, expires_at, last_activity_at, is_revoked)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(sessionId, opUserPre.user_id, opUserPre.credential_version, nowIso, expiresIso, nowIso);

    closeDb();

    // Re-initialize against the exact same database file
    const instance10B = initDb(db10.path);
    const opUserPost = instance10B.prepare("SELECT * FROM users WHERE username = 'operator1'").get();
    assert.strictEqual(opUserPost.credential_version, opUserPre.credential_version, 'User credential_version must be preserved');
    assert.strictEqual(opUserPost.password_hash, opUserPre.password_hash, 'Password hash must be preserved');

    const sessionPost = instance10B.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    assert.ok(sessionPost, 'Session must still exist');
    assert.strictEqual(sessionPost.is_revoked, 0, 'Session must remain unrevoked');
    assert.strictEqual(sessionPost.credential_version, opUserPost.credential_version, 'Session credential version must match user');

    db10.cleanup();
    console.log('[PASS] Test 10: Existing session regression verified across database re-initialization');

    console.log('\n========================================================');
    console.log('ALL 10 SEC-FINDING-001 SECURITY TESTS PASSED CLEANLY');
    console.log('========================================================');
  } finally {
    process.env = originalEnv;
  }
}

runTests().catch(err => {
  console.error('SEC-FINDING-001 Test Failure:', err);
  process.exit(1);
});
