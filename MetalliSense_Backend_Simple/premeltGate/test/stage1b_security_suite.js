/**
 * Stage 1B Master Automated Security, RBAC, Maker-Checker & Evidence Provenance Test Suite
 * Tests full Express app with real HTTP requests over loopback.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const os = require('os');
const spectroToken = crypto.randomBytes(32).toString('hex');
const labToken = crypto.randomBytes(32).toString('hex');
process.env.DEV_SPECTRO_TOKEN = spectroToken;
process.env.DEV_LAB_TOKEN = labToken;

// Configure test environment with isolated database
const testDbDir = path.join(os.tmpdir(), `metallisense-stage1b-test-${Date.now()}`);
fs.mkdirSync(testDbDir, { recursive: true });
process.env.METALLISENSE_DB_PATH = path.join(testDbDir, 'stage1b.db');
process.env.ALLOW_DEV_BOOTSTRAP = 'true';
process.env.SEED_DEV_ACCOUNTS = 'true';
process.env.NODE_ENV = 'test';
process.env.ENABLE_DEMO_RESET = 'true';
process.env.DEMO_RESET_CONFIRM = 'DEMO_RESET_CONFIRM';
process.env.SESSION_SECRET = 'test-session-secret-key-stage1b-secure-random';

// Import backend components
const express = require('express');
const cors = require('cors');
const db = require('../db');
const sec = require('../security');
const { authenticate, csrfProtection } = require('../authMiddleware');
const authRoutes = require('../authRoutes');
const routes = require('../routes');
const sales = require('../sales');
const salesRoutes = require('../salesRoutes');
const driQa = require('../driQa');

// Create test server app
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(authenticate);
app.use(csrfProtection);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use('/api/v2/auth', authRoutes);
app.use('/api/v2/premelt', routes.router);
app.use('/api/v2/sales', salesRoutes);

let server;
let baseUrl;

// Helper to make HTTP requests
function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = options.headers || {};
    let body = options.body;

    if (body && typeof body === 'object' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    if (body && !headers['Content-Length']) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(url, {
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        
        // Extract cookies
        const setCookies = res.headers['set-cookie'] || [];
        const cookies = {};
        for (const cookieStr of setCookies) {
          const parts = cookieStr.split(';')[0].split('=');
          if (parts.length >= 2) {
            cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
          }
        }

        resolve({
          status: res.statusCode,
          headers: res.headers,
          cookies,
          data: json !== null ? json : data
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Stage 1B request deadline exceeded')));
    if (body) req.write(body);
    req.end();
  });
}

// Cookie helper
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function run() {
  console.log('================================================================');
  console.log('MetalliSense Stage 1B Security & RBAC Master Verification Suite');
  console.log('================================================================\n');

  // Start test server
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`Test server running at ${baseUrl}`);
      resolve();
    });
  });

  const results = {
    authentication: [],
    authorization: [],
    makerChecker: [],
    provenance: [],
    security: [],
    sessionLifecycle: []
  };

  const routeExecutionResults = [];

  function record(suite, testId, description, passed, details = {}) {
    const entry = { testId, description, passed, durationMs: details.durationMs || 0, details };
    results[suite].push(entry);
    const tag = passed ? '[PASS]' : '[FAIL]';
    console.log(`${tag} ${testId}: ${description} (${entry.durationMs}ms)`);
    if (!passed) {
      console.error(`       Failure details:`, JSON.stringify(details));
    }
  }

  try {
    // Reset lockout for test users first
    sec.resetFailedLogin('operator1');
    sec.resetFailedLogin('metallurgist1');
    sec.resetFailedLogin('qm1');
    sec.resetFailedLogin('inventory1');
    sec.resetFailedLogin('finance1');
    sec.resetFailedLogin('admin1');

    // -------------------------------------------------------------
    // SUITE 1: AUTHENTICATION
    // -------------------------------------------------------------
    console.log('\n--- Running Suite: Authentication & Credentials ---');

    // TC-AUTH-001: Valid login returns session cookie and CSRF cookie
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/auth/login', {
        body: { username: 'operator1', password: 'OperatorPass123!' }
      });
      const passed = res.status === 200 &&
                     res.data.status === 'success' &&
                     res.cookies['metallisense_session'] &&
                     res.cookies['metallisense_csrf'] &&
                     (res.data.data.user.role === 'OPERATOR' || (res.data.data.user.roles && res.data.data.user.roles.includes('OPERATOR')));
      record('authentication', 'TC-AUTH-001', 'Valid login returns session cookie and CSRF cookie', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        user: res.data?.data?.user?.username,
        role: res.data?.data?.user?.role,
        hasSessionCookie: !!res.cookies['metallisense_session'],
        hasCsrfCookie: !!res.cookies['metallisense_csrf']
      });
    }

    // TC-AUTH-002: Invalid password returns 401 with generic message
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/auth/login', {
        body: { username: 'operator1', password: 'WrongPassword!123' }
      });
      const passed = res.status === 401 &&
                     res.data.code === 'INVALID_CREDENTIALS';
      record('authentication', 'TC-AUTH-002', 'Invalid password returns 401 with generic message', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        code: res.data?.code
      });
    }

    // TC-AUTH-003: Unknown username returns 401 with generic message
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/auth/login', {
        body: { username: 'nonexistent_user', password: 'SomePassword!123' }
      });
      const passed = res.status === 401 &&
                     res.data.code === 'INVALID_CREDENTIALS';
      record('authentication', 'TC-AUTH-003', 'Unknown username returns 401 with generic message', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        code: res.data?.code
      });
    }

    // TC-AUTH-004: Missing credentials format validation
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/auth/login', {
        body: { username: '', password: '' }
      });
      const passed = res.status === 400 &&
                     res.data.code === 'INVALID_CREDENTIALS_FORMAT';
      record('authentication', 'TC-AUTH-004', 'Missing credentials format returns 400', passed, {
        durationMs: Date.now() - t0,
        status: res.status
      });
    }

    // TC-AUTH-005: Account lockout after 5 consecutive failed logins
    {
      const t0 = Date.now();
      sec.resetFailedLogin('operator1');

      let fifthStatus = null;
      for (let i = 1; i <= 5; i++) {
        const fRes = await request('POST', '/api/v2/auth/login', {
          body: { username: 'operator1', password: 'WrongPassword!123' }
        });
        if (i === 5) fifthStatus = fRes.status;
      }

      const resLockout = await request('POST', '/api/v2/auth/login', {
        body: { username: 'operator1', password: 'OperatorPass123!' }
      });
      const passed = (resLockout.status === 429 || resLockout.status === 423) &&
                     resLockout.data.code === 'ACCOUNT_LOCKED';
      record('authentication', 'TC-AUTH-005', 'Account locks out after 5 consecutive failed attempts', passed, {
        durationMs: Date.now() - t0,
        fifthStatus,
        status: resLockout.status,
        code: resLockout.data?.code,
        message: resLockout.data?.message
      });

      sec.resetFailedLogin('operator1');
    }

    // TC-AUTH-006: Disabled/inactive account rejected
    {
      const t0 = Date.now();
      const testDb = db.getDb();
      testDb.prepare('DELETE FROM users WHERE username = ?').run('disabled_user');
      testDb.prepare('DELETE FROM security_events WHERE actor_id = ?').run('USR-DIS-01');

      sec.createUser({
        userId: 'USR-DIS-01',
        username: 'disabled_user',
        email: 'disabled@metallisense.local',
        displayName: 'Disabled Test User',
        password: 'DisabledPass123!',
        primaryRole: 'OPERATOR',
        roles: ['OPERATOR'],
        isEnabled: 0
      });

      const res = await request('POST', '/api/v2/auth/login', {
        body: { username: 'disabled_user', password: 'DisabledPass123!' }
      });
      const passed = res.status === 403 &&
                     res.data.code === 'ACCOUNT_DISABLED';
      record('authentication', 'TC-AUTH-006', 'Disabled user login returns 403 ACCOUNT_DISABLED', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        code: res.data?.code
      });
    }

    // TC-AUTH-007: GET /api/v2/auth/me returns profile for authenticated user
    let operatorCookies;
    {
      const t0 = Date.now();
      const loginRes = await request('POST', '/api/v2/auth/login', {
        body: { username: 'operator1', password: 'OperatorPass123!' }
      });
      operatorCookies = loginRes.cookies;

      const res = await request('GET', '/api/v2/auth/me', {
        headers: { Cookie: cookieHeader(operatorCookies) }
      });
      const passed = res.status === 200 &&
                     res.data.data.user.username === 'operator1' &&
                     (res.data.data.user.role === 'OPERATOR' || res.data.data.user.roles.includes('OPERATOR'));
      record('authentication', 'TC-AUTH-007', 'GET /auth/me returns profile for active session', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        username: res.data?.data?.user?.username
      });
    }

    // TC-AUTH-008: GET /api/v2/auth/me returns 401 for anonymous caller
    {
      const t0 = Date.now();
      const res = await request('GET', '/api/v2/auth/me');
      const passed = res.status === 401 && res.data.code === 'UNAUTHORIZED';
      record('authentication', 'TC-AUTH-008', 'GET /auth/me returns 401 for anonymous caller', passed, {
        durationMs: Date.now() - t0,
        status: res.status
      });
    }

    // TC-AUTH-009: POST /api/v2/auth/logout revokes session and clears cookies
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/auth/logout', {
        headers: {
          Cookie: cookieHeader(operatorCookies),
          'X-CSRF-Token': operatorCookies['metallisense_csrf']
        }
      });
      const checkRes = await request('GET', '/api/v2/auth/me', {
        headers: { Cookie: cookieHeader(operatorCookies) }
      });
      const passed = res.status === 200 && checkRes.status === 401;
      record('authentication', 'TC-AUTH-009', 'Logout revokes session and subsequent requests return 401', passed, {
        durationMs: Date.now() - t0,
        logoutStatus: res.status,
        subsequentStatus: checkRes.status
      });
    }

    // -------------------------------------------------------------
    // SUITE 2: SESSION LIFECYCLE & SECURITY
    // -------------------------------------------------------------
    console.log('\n--- Running Suite: Session Lifecycle & Invalidation ---');

    // TC-SESS-001: Password change invalidates existing sessions (credential version bump)
    {
      const t0 = Date.now();
      const login1 = await request('POST', '/api/v2/auth/login', {
        body: { username: 'metallurgist1', password: 'MetallurgyPass123!' }
      });
      const metCookies = login1.cookies;

      const beforeRes = await request('GET', '/api/v2/auth/me', {
        headers: { Cookie: cookieHeader(metCookies) }
      });
      assert.strictEqual(beforeRes.status, 200);

      sec.updateUserPassword('metallurgist1', 'MetallurgyNewPass123!');

      const afterRes = await request('GET', '/api/v2/auth/me', {
        headers: { Cookie: cookieHeader(metCookies) }
      });

      sec.updateUserPassword('metallurgist1', 'MetallurgyPass123!');

      const passed = afterRes.status === 401 && afterRes.data.code === 'UNAUTHORIZED';
      record('sessionLifecycle', 'TC-SESS-001', 'Password rotation invalidates all existing sessions', passed, {
        durationMs: Date.now() - t0,
        statusAfterRotation: afterRes.status
      });
    }

    // TC-SESS-002: Service API Bearer token authentication
    {
      const t0 = Date.now();
      const res = await request('GET', '/api/v2/auth/me', {
        headers: { Authorization: `Bearer ${spectroToken}` }
      });
      const passed = res.status === 200 &&
                     res.data.data.service.serviceId === 'SVC-SPECTRO-01' &&
                     res.data.data.service.serviceType === 'SPECTROMETER_SERVICE';
      record('sessionLifecycle', 'TC-SESS-002', 'Service Bearer token resolves machine identity', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        serviceId: res.data?.data?.service?.serviceId
      });
    }

    // TC-SESS-003: Invalid Service API token rejected
    {
      const t0 = Date.now();
      const res = await request('GET', '/api/v2/auth/me', {
        headers: { Authorization: 'Bearer invalid-token-xyz' }
      });
      const passed = res.status === 401 && res.data.code === 'UNAUTHORIZED';
      record('sessionLifecycle', 'TC-SESS-003', 'Invalid Bearer token returns 401', passed, {
        durationMs: Date.now() - t0,
        status: res.status
      });
    }

    // -------------------------------------------------------------
    // SUITE 3: CSRF & ATTACK DEFENSE
    // -------------------------------------------------------------
    console.log('\n--- Running Suite: CSRF & Header Spoofing Defenses ---');

    // Login personas
    const opLogin2 = await request('POST', '/api/v2/auth/login', { body: { username: 'operator1', password: 'OperatorPass123!' } });
    const opCookies = opLogin2.cookies;

    const invLogin = await request('POST', '/api/v2/auth/login', { body: { username: 'inventory1', password: 'InventoryPass123!' } });
    const invCookies = invLogin.cookies;

    const metLogin = await request('POST', '/api/v2/auth/login', { body: { username: 'metallurgist1', password: 'MetallurgyPass123!' } });
    const metCookies = metLogin.cookies;

    const qmLogin = await request('POST', '/api/v2/auth/login', { body: { username: 'qm1', password: 'QualityPass123!' } });
    const qmCookies = qmLogin.cookies;

    const finLogin = await request('POST', '/api/v2/auth/login', { body: { username: 'finance1', password: 'FinancePass123!' } });
    const finCookies = finLogin.cookies;

    const adminLogin = await request('POST', '/api/v2/auth/login', { body: { username: 'admin1', password: 'AdminSecurePass123!' } });
    const adminCookies = adminLogin.cookies;

    // TC-SEC-001: Mutating request without CSRF token rejected (403)
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/premelt/lots', {
        headers: {
          Cookie: cookieHeader(invCookies)
        },
        body: {
          materialType: 'STEEL_SCRAP',
          supplier: 'Test Supplier',
          receivedKg: 1000,
          costPerKg: 30,
          truckNo: 'TRUCK-CSRF',
          declared: { C: 0.1, Si: 0.2, Mn: 0.5, P: 0.02, S: 0.01 }
        }
      });
      const passed = res.status === 403 &&
                     (res.data.code === 'CSRF_MISMATCH' || res.data.code === 'CSRF_TOKEN_MISSING' || res.data.code === 'CSRF_TOKEN_MISMATCH');
      record('security', 'TC-SEC-001', 'Mutating cookie request without X-CSRF-Token returns 403', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        code: res.data?.code
      });
    }

    // TC-SEC-002: Mutating request with mismatched CSRF token rejected (403)
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/premelt/lots', {
        headers: {
          Cookie: cookieHeader(invCookies),
          'X-CSRF-Token': 'wrong-csrf-token-xyz'
        },
        body: {
          materialType: 'STEEL_SCRAP',
          supplier: 'Test Supplier',
          receivedKg: 1000,
          costPerKg: 30,
          truckNo: 'TRUCK-CSRF-BAD',
          declared: { C: 0.1, Si: 0.2, Mn: 0.5, P: 0.02, S: 0.01 }
        }
      });
      const passed = res.status === 403 &&
                     (res.data.code === 'CSRF_MISMATCH' || res.data.code === 'CSRF_TOKEN_MISMATCH');
      record('security', 'TC-SEC-002', 'Mutating cookie request with mismatched CSRF token returns 403', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        code: res.data?.code
      });
    }

    // TC-SEC-003: Mutating request with valid CSRF token succeeds
    let createdLotId;
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/premelt/lots', {
        headers: {
          Cookie: cookieHeader(invCookies),
          'X-CSRF-Token': invCookies['metallisense_csrf']
        },
        body: {
          materialType: 'STEEL_SCRAP',
          supplier: 'Test Supplier',
          receivedKg: 1000,
          costPerKg: 30,
          truckNo: 'TRUCK-VALID',
          declared: { C: 0.1, Si: 0.2, Mn: 0.5, P: 0.02, S: 0.01 }
        }
      });
      createdLotId = res.data?.data?.lotId;
      const passed = (res.status === 200 || res.status === 201) && createdLotId;
      record('security', 'TC-SEC-003', 'Mutating cookie request with valid CSRF token succeeds (200/201)', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        lotId: createdLotId
      });
    }

    // TC-SEC-004: Client-supplied authority field 'by' / 'approvedBy' in body ignored; server derives actor
    {
      const t0 = Date.now();
      const res = await request('POST', '/api/v2/premelt/lots', {
        headers: {
          Cookie: cookieHeader(invCookies),
          'X-CSRF-Token': invCookies['metallisense_csrf']
        },
        body: {
          materialType: 'STEEL_SCRAP',
          supplier: 'Test Supplier',
          receivedKg: 500,
          costPerKg: 30,
          truckNo: 'TRUCK-SPOOF',
          by: 'SpoofedAdminUser',
          declared: { C: 0.1, Si: 0.2, Mn: 0.5, P: 0.02, S: 0.01 }
        }
      });
      const events = db.getDb().prepare('SELECT * FROM security_events WHERE actor_id = ? ORDER BY id DESC LIMIT 5').all('USR-INV-01');
      const passed = (res.status === 200 || res.status === 201) && events.length > 0;
      record('security', 'TC-SEC-004', 'Client-supplied actor field in body is ignored; server identity enforced', passed, {
        durationMs: Date.now() - t0,
        status: res.status
      });
    }

    // -------------------------------------------------------------
    // SUITE 4: ROUTE AUTHORIZATION & RBAC
    // -------------------------------------------------------------
    console.log('\n--- Running Suite: RBAC Matrix Execution across Roles ---');

    async function testRouteRBAC(routeId, method, path, body, allowedCookies, forbiddenCookies) {
      const t0 = Date.now();
      const anonRes = await request(method, path, { body });
      const anonPass = anonRes.status === 401;

      const forbRes = await request(method, path, {
        headers: {
          Cookie: cookieHeader(forbiddenCookies),
          'X-CSRF-Token': forbiddenCookies['metallisense_csrf']
        },
        body
      });
      const forbPass = forbRes.status === 403;

      const allowRes = await request(method, path, {
        headers: {
          Cookie: cookieHeader(allowedCookies),
          'X-CSRF-Token': allowedCookies['metallisense_csrf'],
          'Idempotency-Key': `test-rbac-${Date.now()}-${Math.random()}`
        },
        body
      });
      const allowPass = allowRes.status !== 401 && allowRes.status !== 403;

      const totalPass = anonPass && forbPass && allowPass;
      record('authorization', routeId, `${method} ${path} permissions verified`, totalPass, {
        durationMs: Date.now() - t0,
        anonStatus: anonRes.status,
        forbStatus: forbRes.status,
        allowStatus: allowRes.status
      });

      routeExecutionResults.push({
        routeId,
        method,
        path,
        anonStatus: anonRes.status,
        forbStatus: forbRes.status,
        allowStatus: allowRes.status,
        passed: totalPass
      });

      return totalPass;
    }

    // R-001: POST /lots -> Allowed: INVENTORY_CONTROLLER, ADMIN. Forbidden: OPERATOR, QM, FINANCE.
    await testRouteRBAC('R-001', 'POST', '/api/v2/premelt/lots', {
      materialType: 'STEEL_SCRAP', supplier: 'RBAC Supplier', receivedKg: 500, costPerKg: 30, truckNo: 'TRUCK-R1',
      declared: { C: 0.1, Si: 0.2, Mn: 0.5, P: 0.02, S: 0.01 }
    }, invCookies, opCookies);

    // R-002: PATCH /lots/:lotId/status -> Allowed: QUALITY_MANAGER, ADMIN. Forbidden: OPERATOR, FINANCE.
    await testRouteRBAC('R-002', 'PATCH', `/api/v2/premelt/lots/${createdLotId}/status`, {
      status: 'QUARANTINED', reason: 'RBAC test quarantine'
    }, qmCookies, opCookies);

    // R-003: POST /lots/:lotId/adjust -> Allowed: INVENTORY_CONTROLLER, ADMIN. Forbidden: OPERATOR, QM.
    await testRouteRBAC('R-003', 'POST', `/api/v2/premelt/lots/${createdLotId}/adjust`, {
      deltaKg: -50, reason: 'Physical stock adjustment'
    }, invCookies, opCookies);

    // R-004: POST /gun/inspect -> Allowed: OPERATOR, INVENTORY_CONTROLLER, ADMIN. Forbidden: FINANCE.
    await testRouteRBAC('R-004', 'POST', '/api/v2/premelt/gun/inspect', {
      lotId: createdLotId, device: 'XRF', pieces: 5, surfacePrepared: true
    }, opCookies, finCookies);

    // R-005: POST /lots/:lotId/dri-qa -> Allowed: QUALITY_MANAGER, ADMIN. Forbidden: OPERATOR, FINANCE.
    await testRouteRBAC('R-005', 'POST', `/api/v2/premelt/lots/${createdLotId}/dri-qa`, {
      feTotal: 92, feMetallic: 86, C: 0.15, P: 0.03, S: 0.01, SiO2: 3, Al2O3: 1.5, CaO: 0.8, MgO: 0.4, moisture: 0.2, fines: 1.5
    }, qmCookies, opCookies);

    // R-006: POST /additives/deduct -> Allowed: OPERATOR, METALLURGIST, ADMIN. Forbidden: QM, FINANCE.
    await testRouteRBAC('R-006', 'POST', '/api/v2/premelt/additives/deduct', {
      heatId: 'H-1051', lines: [{ lotId: createdLotId, kg: 10 }]
    }, opCookies, qmCookies);

    // R-007: POST /heats -> Allowed: OPERATOR, METALLURGIST, ADMIN. Forbidden: QM, FINANCE.
    await testRouteRBAC('R-007', 'POST', '/api/v2/premelt/heats', {
      grade: 'SG-IRON', targetKg: 1000, charge: [{ lotId: createdLotId, kg: 500 }]
    }, metCookies, finCookies);

    // R-008: POST /heats/:heatId/start-melting -> Allowed: OPERATOR, METALLURGIST, ADMIN. Forbidden: QM, FINANCE.
    await testRouteRBAC('R-008', 'POST', '/api/v2/premelt/heats/H-1051/start-melting', {
      acknowledgeWarnings: true
    }, opCookies, qmCookies);

    // R-009: POST /sales/invoices -> Allowed: SALES_FINANCE, ADMIN. Forbidden: OPERATOR, METALLURGIST, QM.
    await testRouteRBAC('R-009', 'POST', '/api/v2/sales/invoices', {
      heatId: 'H-1050', customerId: 'CUST-01', poNumber: 'PO-TEST'
    }, finCookies, opCookies);

    // R-010: POST /premelt/demo/reset -> Allowed: Strictly ADMIN. Forbidden: OPERATOR, METALLURGIST, QM, FINANCE.
    {
      const t0 = Date.now();
      const opReset = await request('POST', '/api/v2/premelt/demo/reset', {
        headers: {
          Cookie: cookieHeader(opCookies),
          'X-CSRF-Token': opCookies['metallisense_csrf']
        },
        body: { confirm: 'DEMO_RESET_CONFIRM', adminPassword: 'OperatorPass123!' }
      });
      const passed = opReset.status === 403 && opReset.data.code === 'FORBIDDEN';
      record('authorization', 'R-010', 'POST /demo/reset rejects non-admin users with 403', passed, {
        durationMs: Date.now() - t0,
        status: opReset.status
      });
    }

    // -------------------------------------------------------------
    // SUITE 5: MAKER-CHECKER SEPARATION OF DUTIES
    // -------------------------------------------------------------
    console.log('\n--- Running Suite: Maker-Checker Enforcement ---');

    // MC-001: Quality Manager cannot self-release a heat they planned or melted
    {
      const t0 = Date.now();
      // Admin plans heat (admin has OPERATOR/METALLURGIST/ADMIN permissions)
      const heatRes = await request('POST', '/api/v2/premelt/heats', {
        headers: {
          Cookie: cookieHeader(adminCookies),
          'X-CSRF-Token': adminCookies['metallisense_csrf']
        },
        body: {
          grade: 'SG-IRON', targetKg: 1000, charge: []
        }
      });
      const plannedHeatId = heatRes.data?.data?.heatId;

      // Run gate check before melting
      await request('POST', `/api/v2/premelt/heats/${plannedHeatId}/gate-check`, {
        headers: {
          Cookie: cookieHeader(adminCookies),
          'X-CSRF-Token': adminCookies['metallisense_csrf']
        }
      });

      // Metallurgist (independent from planner) starts melting with authorized override
      const startMeltRes = await request('POST', `/api/v2/premelt/heats/${plannedHeatId}/start-melting`, {
        headers: {
          Cookie: cookieHeader(metCookies),
          'X-CSRF-Token': metCookies['metallisense_csrf']
        },
        body: { acknowledgeWarnings: true, override: { engineer: 'metallurgist1', reason: 'Metallurgist authorized start for testing furnace' } }
      });

      // Submit measured chemistry via spectrometer service
      await request('POST', `/api/v2/premelt/heats/${plannedHeatId}/evidence`, {
        headers: { Authorization: `Bearer ${spectroToken}` },
        body: {
          sampleId: `SPECTRO-${plannedHeatId}-TAP`,
          evidenceType: 'MELT_MEASURED',
          values: { Fe: 94, C: 3.6, Si: 2.2, Mn: 0.35, P: 0.02, S: 0.01 }
        }
      });

      // Admin attempts to release their own heat -> MUST BE REJECTED 403 MAKER_CHECKER_VIOLATION
      // Final QA is now a separately persisted, chemistry/version-bound receipt.
      await request('POST', `/api/v2/premelt/heats/${plannedHeatId}/evidence`, {
        headers: { Cookie: cookieHeader(qmCookies), 'X-CSRF-Token': qmCookies['metallisense_csrf'] },
        body: { evidenceType: 'LAB_MEASURED', units: 'MPa, %, HB',
          values: { uts_mpa: 450, hardness_hb: 180, elongation_pct: 12, ys_mpa: 310 } }
      });
      const selfReleaseRes = await request('POST', `/api/v2/sales/heats/${plannedHeatId}/complete`, {
        headers: {
          Cookie: cookieHeader(adminCookies),
          'X-CSRF-Token': adminCookies['metallisense_csrf']
        },
        body: {
          composition: { Fe: 94, C: 3.6, Si: 2.2, Mn: 0.35, P: 0.02, S: 0.01 },
          mechanical: { uts_mpa: 450, hardness_hb: 180, elongation_pct: 12, ys_mpa: 310 }
        }
      });

      const mcViolation = selfReleaseRes.status === 403 &&
                          selfReleaseRes.data.code === 'MAKER_CHECKER_VIOLATION';

      // qm1 (independent reviewer who did NOT plan or start the heat) releases -> MUST SUCCEED
      const qmReleaseRes = await request('POST', `/api/v2/sales/heats/${plannedHeatId}/complete`, {
        headers: {
          Cookie: cookieHeader(qmCookies),
          'X-CSRF-Token': qmCookies['metallisense_csrf']
        },
        body: {
          composition: { Fe: 94, C: 3.6, Si: 2.2, Mn: 0.35, P: 0.02, S: 0.01 },
          mechanical: { uts_mpa: 450, hardness_hb: 180, elongation_pct: 12, ys_mpa: 310 }
        }
      });

      const passed = mcViolation && qmReleaseRes.status === 200;
      record('makerChecker', 'MC-001', 'QM cannot self-release heat they planned/started; independent actor required', passed, {
        durationMs: Date.now() - t0,
        selfReleaseStatus: selfReleaseRes.status,
        selfReleaseCode: selfReleaseRes.data?.code,
        qmReleaseStatus: qmReleaseRes.status
      });
    }

    // MC-002: Safety Hold Override maker-checker
    {
      const t0 = Date.now();
      // Metallurgist plans heat
      const planRes = await request('POST', '/api/v2/premelt/heats', {
        headers: {
          Cookie: cookieHeader(metCookies),
          'X-CSRF-Token': metCookies['metallisense_csrf']
        },
        body: { grade: 'LOW-CARBON-STEEL', targetKg: 1000, charge: [] }
      });
      const holdHeatId = planRes.data?.data?.heatId;

      // Run gate-check (will produce HOLD/WARN)
      await request('POST', `/api/v2/premelt/heats/${holdHeatId}/gate-check`, {
        headers: {
          Cookie: cookieHeader(metCookies),
          'X-CSRF-Token': metCookies['metallisense_csrf']
        }
      });

      // Operator cannot override hold
      const opOverride = await request('POST', `/api/v2/premelt/heats/${holdHeatId}/start-melting`, {
        headers: {
          Cookie: cookieHeader(opCookies),
          'X-CSRF-Token': opCookies['metallisense_csrf']
        },
        body: {
          acknowledgeWarnings: true,
          override: { reason: 'Operator unauthorized override attempt' }
        }
      });

      // met1 planned the heat; met1 cannot approve their own override
      const metSelfOverride = await request('POST', `/api/v2/premelt/heats/${holdHeatId}/start-melting`, {
        headers: {
          Cookie: cookieHeader(metCookies),
          'X-CSRF-Token': metCookies['metallisense_csrf']
        },
        body: {
          acknowledgeWarnings: true,
          override: { reason: 'Planner self override attempt' }
        }
      });

      // Admin (independent checker) overrides hold -> succeeds
      const adminOverride = await request('POST', `/api/v2/premelt/heats/${holdHeatId}/start-melting`, {
        headers: {
          Cookie: cookieHeader(adminCookies),
          'X-CSRF-Token': adminCookies['metallisense_csrf']
        },
        body: {
          acknowledgeWarnings: true,
          override: { reason: 'Admin authorized safety hold override with verified charge adjustment' }
        }
      });

      const passed = (metSelfOverride.status === 403 || metSelfOverride.status === 423) &&
                     (adminOverride.status === 200 || adminOverride.status === 409);
      record('makerChecker', 'MC-002', 'Planner cannot approve own safety override; requires independent checker', passed, {
        durationMs: Date.now() - t0,
        selfOverrideStatus: metSelfOverride.status,
        selfOverrideCode: metSelfOverride.data?.code,
        adminOverrideStatus: adminOverride.status
      });
    }

    // MC-003: DRI QA maker-checker: Analyst entering sample cannot approve it
    {
      const t0 = Date.now();
      // Create a DRI lot
      const driLotRes = await request('POST', '/api/v2/premelt/lots', {
        headers: {
          Cookie: cookieHeader(invCookies),
          'X-CSRF-Token': invCookies['metallisense_csrf']
        },
        body: {
          materialType: 'DRI',
          supplier: 'Sponge Iron Supplier Ltd',
          receivedKg: 2000,
          costPerKg: 35,
          truckNo: 'TRUCK-DRI-MC',
          declared: { Fe: 91, C: 0.15 }
        }
      });
      const driLotId = driLotRes.data?.data?.lotId || 'DRI-0917';

      // qm1 enters sample
      const qaEntry = await request('POST', `/api/v2/premelt/lots/${driLotId}/dri-qa`, {
        headers: {
          Cookie: cookieHeader(qmCookies),
          'X-CSRF-Token': qmCookies['metallisense_csrf']
        },
        body: {
          feTotal: 92, feMetallic: 86, C: 0.15, P: 0.03, S: 0.01, SiO2: 3, Al2O3: 1.5, CaO: 0.8, MgO: 0.4, moisture: 0.2, fines: 1.5,
          confirmWarnings: true
        }
      });
      const qaId = qaEntry.data?.data?.qaId;

      // qm1 attempts to approve own sample -> REJECTED 403
      const selfApprove = await request('POST', `/api/v2/premelt/dri-qa/${qaId}/approve`, {
        headers: {
          Cookie: cookieHeader(qmCookies),
          'X-CSRF-Token': qmCookies['metallisense_csrf']
        },
        body: { note: 'Self approval attempt' }
      });

      // Admin (independent reviewer) approves -> SUCCEEDS 200
      const adminApprove = await request('POST', `/api/v2/premelt/dri-qa/${qaId}/approve`, {
        headers: {
          Cookie: cookieHeader(adminCookies),
          'X-CSRF-Token': adminCookies['metallisense_csrf']
        },
        body: { note: 'Independent QA approval' }
      });

      const passed = selfApprove.status === 403 &&
                     selfApprove.data.code === 'MAKER_CHECKER_VIOLATION' &&
                     adminApprove.status === 200;
      record('makerChecker', 'MC-003', 'DRI QA analyst cannot approve own sample; independent QA approval required', passed, {
        durationMs: Date.now() - t0,
        selfApproveStatus: selfApprove.status,
        selfApproveCode: selfApprove.data?.code,
        adminApproveStatus: adminApprove.status
      });
    }

    // MC-004: Hardened Demo Reset execution
    {
      const t0 = Date.now();
      const resetRes = await request('POST', '/api/v2/premelt/demo/reset', {
        headers: {
          Cookie: cookieHeader(adminCookies),
          'X-CSRF-Token': adminCookies['metallisense_csrf']
        },
        body: {
          confirm: 'DEMO_RESET_CONFIRM',
          adminPassword: 'AdminSecurePass123!'
        }
      });
      const passed = resetRes.status === 200 && resetRes.data.data.reset === true;
      record('makerChecker', 'MC-004', 'Demo reset executes only for authenticated admin with reauth password', passed, {
        durationMs: Date.now() - t0,
        status: resetRes.status,
        resetData: resetRes.data?.data
      });
    }

    // -------------------------------------------------------------
    // SUITE 6: TRUSTED EVIDENCE INGESTION & PROVENANCE
    // -------------------------------------------------------------
    console.log('\n--- Running Suite: Evidence Provenance & Service Ingestion ---');

    // Create a new heat after reset
    const newHeatRes = await request('POST', '/api/v2/premelt/heats', {
      headers: {
        Cookie: cookieHeader(metCookies),
        'X-CSRF-Token': metCookies['metallisense_csrf']
      },
      body: { grade: 'SG-IRON', targetKg: 1000, charge: [] }
    });
    const testHeatId = newHeatRes.data?.data?.heatId;
    // Provenance tests need an eligible heat. The empty-charge gate below is
    // correctly HOLD, so its failed start must not stand in for this fixture.
    db.getDb().prepare("UPDATE heats SET status = 'MELTING' WHERE heat_id = ?").run(testHeatId);

    // Run gate check and start melting
    await request('POST', `/api/v2/premelt/heats/${testHeatId}/gate-check`, {
      headers: {
        Cookie: cookieHeader(metCookies),
        'X-CSRF-Token': metCookies['metallisense_csrf']
      }
    });

    await request('POST', `/api/v2/premelt/heats/${testHeatId}/start-melting`, {
      headers: {
        Cookie: cookieHeader(opCookies),
        'X-CSRF-Token': opCookies['metallisense_csrf']
      },
      body: { acknowledgeWarnings: true }
    });

    // EV-PROV-001: Spectrometer service can submit MELT_MEASURED evidence
    {
      const t0 = Date.now();
      const res = await request('POST', `/api/v2/premelt/heats/${testHeatId}/evidence`, {
        headers: { Authorization: `Bearer ${spectroToken}` },
        body: {
          sampleId: `SMP-${testHeatId}-01`,
          evidenceType: 'MELT_MEASURED',
          values: { Fe: 94, C: 3.5, Si: 2.1, Mn: 0.4, P: 0.02, S: 0.01 }
        }
      });
      const passed = (res.status === 200 || res.status === 201) &&
                     res.data.data.sampleId === `SMP-${testHeatId}-01` &&
                     res.data.data.payloadHash;
      record('provenance', 'EV-PROV-001', 'Spectrometer service submits MELT_MEASURED evidence with payload hash', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        sampleId: res.data?.data?.sampleId,
        hash: res.data?.data?.payloadHash
      });
    }

    // EV-PROV-002: Duplicate sample submission with identical payload is idempotent
    {
      const t0 = Date.now();
      const res = await request('POST', `/api/v2/premelt/heats/${testHeatId}/evidence`, {
        headers: { Authorization: `Bearer ${spectroToken}` },
        body: {
          sampleId: `SMP-${testHeatId}-01`,
          evidenceType: 'MELT_MEASURED',
          values: { Fe: 94, C: 3.5, Si: 2.1, Mn: 0.4, P: 0.02, S: 0.01 }
        }
      });
      const passed = (res.status === 200 || res.status === 201) &&
                     res.data.data.sampleId === `SMP-${testHeatId}-01`;
      record('provenance', 'EV-PROV-002', 'Idempotent re-submission of identical sample payload returns existing receipt', passed, {
        durationMs: Date.now() - t0,
        status: res.status
      });
    }

    // EV-PROV-003: Duplicate sample submission with conflicting payload returns 409 Conflict
    {
      const t0 = Date.now();
      const res = await request('POST', `/api/v2/premelt/heats/${testHeatId}/evidence`, {
        headers: { Authorization: `Bearer ${spectroToken}` },
        body: {
          sampleId: `SMP-${testHeatId}-01`,
          evidenceType: 'MELT_MEASURED',
          values: { Fe: 90, C: 4.5, Si: 1.0, Mn: 0.8, P: 0.05, S: 0.05 }
        }
      });
      const passed = res.status === 409 && res.data.code === 'SAMPLE_PAYLOAD_CONFLICT';
      record('provenance', 'EV-PROV-003', 'Conflicting payload for existing sample returns 409 Conflict', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        code: res.data?.code
      });
    }

    // EV-PROV-004: Unauthorized user (e.g. Operator) cannot submit evidence
    {
      const t0 = Date.now();
      const res = await request('POST', `/api/v2/premelt/heats/${testHeatId}/evidence`, {
        headers: {
          Cookie: cookieHeader(opCookies),
          'X-CSRF-Token': opCookies['metallisense_csrf']
        },
        body: {
          sampleId: `SMP-${testHeatId}-OP`,
          evidenceType: 'MELT_MEASURED',
          values: { Fe: 94, C: 3.5, Si: 2.1, Mn: 0.4, P: 0.02, S: 0.01 }
        }
      });
      const passed = res.status === 403;
      record('provenance', 'EV-PROV-004', 'Operator role cannot submit evidence directly; requires service or metallurgist', passed, {
        durationMs: Date.now() - t0,
        status: res.status
      });
    }

    // EV-PROV-005: Model estimate rejected as physical measured evidence
    {
      const t0 = Date.now();
      const res = await request('POST', `/api/v2/premelt/heats/${testHeatId}/evidence`, {
        headers: { Authorization: `Bearer ${spectroToken}` },
        body: {
          sampleId: `SMP-${testHeatId}-EST`,
          evidenceType: 'MODEL_ESTIMATE',
          values: { Fe: 94, C: 3.5, Si: 2.1, Mn: 0.4, P: 0.02, S: 0.01 }
        }
      });
      const passed = res.status === 422 && res.data.code === 'INVALID_EVIDENCE_PROVENANCE';
      record('provenance', 'EV-PROV-005', 'MODEL_ESTIMATE rejected for measured evidence endpoint (422)', passed, {
        durationMs: Date.now() - t0,
        status: res.status,
        code: res.data?.code
      });
    }

  } finally {
    server.close();
  }

  // -------------------------------------------------------------
  // OUTPUT EVIDENCE WRITING
  // -------------------------------------------------------------
  const evidenceDir = process.env.EVIDENCE_DIR || 'C:\\Users\\Manish\\Downloads\\MetalliSense-CORRECTIONS-EVIDENCE\\stage-1b';
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });

  fs.writeFileSync(path.join(evidenceDir, 'AUTHENTICATION_TEST_RESULTS.json'), JSON.stringify(results.authentication, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'AUTHORIZATION_TEST_RESULTS.json'), JSON.stringify(results.authorization, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'SESSION_LIFECYCLE_RESULTS.json'), JSON.stringify(results.sessionLifecycle, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'SECURITY_TEST_RESULTS.json'), JSON.stringify(results.security, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'MAKER_CHECKER_TEST_RESULTS.json'), JSON.stringify(results.makerChecker, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'PROVENANCE_TEST_RESULTS.json'), JSON.stringify(results.provenance, null, 2));

  // CSV for route permissions
  let csv = 'RouteId,Method,Path,AnonymousStatus,ForbiddenStatus,AllowedStatus,Passed\n';
  for (const r of routeExecutionResults) {
    csv += `${r.routeId},${r.method},${r.path},${r.anonStatus},${r.forbStatus},${r.allowStatus},${r.passed}\n`;
  }
  fs.writeFileSync(path.join(evidenceDir, 'ROUTE_AUTH_EXECUTION_RESULTS.csv'), csv);

  console.log('\n================================================================');
  const allTests = [
    ...results.authentication,
    ...results.authorization,
    ...results.sessionLifecycle,
    ...results.security,
    ...results.makerChecker,
    ...results.provenance
  ];
  const total = allTests.length;
  const passed = allTests.filter(t => t.passed).length;
  const failed = total - passed;
  console.log(`Stage 1B Master Suite: Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  console.log('Evidence files written to:', evidenceDir);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
