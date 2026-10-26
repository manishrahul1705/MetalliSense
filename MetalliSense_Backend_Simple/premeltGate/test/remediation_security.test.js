/**
 * MetalliSense Security Remediation Verification Suite
 *
 * Formally verifies closing of confirmed Stage F security gaps:
 * 1. Anonymous rejection on all state-changing, proxy, and maintenance endpoints
 * 2. Strict least-privilege RBAC role enforcement (forbidden roles return 403)
 * 3. Permitted actions for authorized roles
 * 4. Production environment restrictions on simulation, demo reset, and synthetic generation
 * 5. Zero-upstream dispatch on rejected proxy requests (local upstream stub proof)
 * 6. Reachable URL alias security parity (all mounted prefix shapes enforce identical guards)
 * 7. Double-submit cookie CSRF enforcement on mutating endpoints
 * 8. Zero state mutation on rejected attempts (in-memory and SQLite integrity)
 */
const assert = require('assert');
const http = require('http');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
process.chdir(BACKEND_DIR);
process.env.NODE_ENV = 'test';
process.env.ENABLE_DEMO_RESET = 'true';
process.env.DEMO_RESET_CONFIRM = 'DEMO_RESET_CONFIRM';
process.env.SESSION_SECRET = 'test-audit-session-secret-stage-f';

const { initTestDb, getDb, createMeltingHeat } = require('./testHelper');
const { bootstrapDevAccounts } = require('../db');
const sec = require('../security');
const { app } = require('../../server');

let server;
let baseUrl;
let upstreamStubServer;
let upstreamStubPort;
let upstreamCallCount = 0;

function request(method, reqPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    let bodyStr = null;
    if (typeof body === 'string') {
      bodyStr = body;
    } else if (body !== null && body !== undefined) {
      bodyStr = JSON.stringify(body);
    }
    if (bodyStr) reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        const setCookies = res.headers['set-cookie'] || [];
        const cookies = {};
        for (const c of setCookies) {
          const parts = c.split(';')[0].split('=');
          if (parts.length >= 2) cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
        }
        resolve({ status: res.statusCode, data: json || data, cookies, raw: data });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function cookieHdr(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function runTests() {
  console.log('\n============================================================');
  console.log('MetalliSense Targeted Security Remediation Suite');
  console.log('============================================================\n');

  // 1. Initialize Upstream Stub to verify Zero Upstream Calls on Rejection
  await new Promise((res) => {
    upstreamStubServer = http.createServer((req, resStub) => {
      upstreamCallCount++;
      resStub.writeHead(200, { 'Content-Type': 'application/json' });
      resStub.end(JSON.stringify({ status: 'success', stubbed: true }));
    }).listen(0, '127.0.0.1', () => {
      upstreamStubPort = upstreamStubServer.address().port;
      res();
    });
  });

  // Redirect environment variables to local stub
  process.env.AGENT_SERVICE_URL = `http://127.0.0.1:${upstreamStubPort}`;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${upstreamStubPort}`;
  process.env.AI_ENGINE_URL = `http://127.0.0.1:${upstreamStubPort}`;

  // 2. Start Application Server
  initTestDb();
  bootstrapDevAccounts(getDb(), { forceBootstrap: true });
  createMeltingHeat('H-REMED-001', 5000);

  await new Promise((res) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      res();
    });
  });

  console.log(`Test gateway listening on ${baseUrl}`);
  console.log(`Upstream mock stub listening on http://127.0.0.1:${upstreamStubPort}\n`);

  // 3. Authenticate Personas
  const personas = {};
  for (const [user, pwd, role] of [
    ['operator1', 'OperatorPass123!', 'OPERATOR'],
    ['inventory1', 'InventoryPass123!', 'INVENTORY_CONTROLLER'],
    ['metallurgist1', 'MetallurgyPass123!', 'METALLURGIST'],
    ['qm1', 'QualityPass123!', 'QUALITY_MANAGER'],
    ['finance1', 'FinancePass123!', 'SALES_FINANCE'],
    ['admin1', 'AdminSecurePass123!', 'ADMIN'],
  ]) {
    const r = await request('POST', '/api/v2/auth/login', { body: { username: user, password: pwd } });
    assert.strictEqual(r.status, 200, `Login failed for ${user}`);
    personas[role] = { cookies: r.cookies, csrf: r.cookies['metallisense_csrf'] };
  }

  let passed = 0;
  let total = 0;

  function check(desc, condition) {
    total++;
    if (condition) {
      console.log(`[PASS] ${desc}`);
      passed++;
    } else {
      console.error(`[FAIL] ${desc}`);
      throw new Error(`Assertion failed: ${desc}`);
    }
  }

  // TEST SUITE 1: Anonymous Rejection on Remediated Endpoints
  console.log('\n--- Section 1: Anonymous Rejection on Remediated Endpoints ---');
  const anonTargets = [
    ['POST', '/api/v2/alerts/simulate', { grade: 'SG-IRON', severity: 'HIGH' }],
    ['POST', '/api/v2/ai/anomaly/predict', { composition: { C: 3.5 }, grade: 'SG-IRON' }],
    ['POST', '/api/v2/ai/individual/analyze', { metalGrade: 'SG-IRON', composition: { C: 3.5 } }],
    ['POST', '/api/v2/ai/agent/analyze', { metalGrade: 'SG-IRON', composition: { C: 3.5 } }],
    ['POST', '/api/v2/ai/explain', { grade: 'SG-IRON', composition: { C: 3.5 } }],
    ['POST', '/api/v2/ai/what-if', { grade: 'SG-IRON', composition: { C: 3.5 } }],
    ['POST', '/api/v2/rl/optimize', { grade: 'SG-IRON', composition: { C: 3.5 } }],
    ['POST', '/api/v2/rl/feedback', { grade: 'SG-IRON', outcome: 'good' }],
    ['POST', '/api/v2/vector/reindex', {}],
    ['POST', '/api/v2/vector/search', { query: 'desulfurization' }],
    ['POST', '/api/v2/vector/memory/add', { text: 'memory' }],
    ['POST', '/api/v2/cost/estimate', { grade: 'SG-IRON', batchWeightKg: 1000 }],
    ['POST', '/api/v2/carbon/estimate', { grade: 'SG-IRON', batchWeightKg: 1000 }],
    ['POST', '/api/v2/workflow/full-analysis', { metalGrade: 'SG-IRON', composition: { C: 3.5 } }],
    ['POST', '/api/v2/mechanical/predict', { grade: 'SG-IRON', composition: { C: 3.5, Si: 2.0 } }],
    ['POST', '/api/v2/mechanical/ce-check', { grade: 'SG-IRON', composition: { C: 3.5, Si: 2.0 } }],
    ['POST', '/api/v2/synthetic/opc-connect', {}],
    ['POST', '/api/v2/synthetic/generate-synthetic', { metalGrade: 'SG-IRON' }],
    ['POST', '/api/v2/synthetic', { metalGrade: 'SG-IRON' }],
    ['DELETE', '/api/v2/synthetic/1', {}]
  ];

  for (const [method, p, b] of anonTargets) {
    const res = await request(method, p, { body: b });
    check(`Anonymous ${method} ${p} rejected with 401 UNAUTHORIZED`, res.status === 401 && res.data?.code === 'UNAUTHORIZED');
  }

  // TEST SUITE 2: Strict RBAC Role Rejection (Forbidden Roles Return 403)
  console.log('\n--- Section 2: Strict RBAC Role Rejection (Forbidden Roles Return 403) ---');
  const rbacTargets = [
    ['POST', '/api/v2/vector/reindex', {}, 'OPERATOR', 'ADMIN required'],
    ['POST', '/api/v2/grades', { name: 'GRADE-NEW' }, 'OPERATOR', 'METALLURGIST required'],
    ['PATCH', '/api/v2/carbon/factors', { elementCarbon: {} }, 'OPERATOR', 'METALLURGIST required'],
    ['PATCH', '/api/v2/cost/prices', { elementPrices: {} }, 'OPERATOR', 'SALES_FINANCE required'],
    ['POST', '/api/v2/synthetic/generate-synthetic', { metalGrade: 'SG-IRON' }, 'OPERATOR', 'METALLURGIST required'],
    ['DELETE', '/api/v2/synthetic/1', {}, 'METALLURGIST', 'ADMIN required'],
    ['POST', '/api/v2/premelt/lots', { materialType: 'STEEL_SCRAP' }, 'OPERATOR', 'INVENTORY_CONTROLLER required'],
    ['POST', '/api/v2/premelt/heats', { targetGrade: 'SG-IRON' }, 'SALES_FINANCE', 'OPERATOR/METALLURGIST required'],
    ['POST', '/api/v2/premelt/corrections/approve', { candidateId: 'C1' }, 'OPERATOR', 'METALLURGIST required']
  ];

  for (const [method, p, b, role, note] of rbacTargets) {
    const persona = personas[role];
    const res = await request(method, p, {
      headers: { Cookie: cookieHdr(persona.cookies), 'X-CSRF-Token': persona.csrf },
      body: b
    });
    check(`Role ${role} on ${method} ${p} rejected with 403 FORBIDDEN (${note})`, res.status === 403 && res.data?.code === 'FORBIDDEN');
  }

  // TEST SUITE 3: Permitted Action for Authorized Roles
  console.log('\n--- Section 3: Permitted Action for Authorized Roles ---');
  // Admin on vector reindex
  const adminReindex = await request('POST', '/api/v2/vector/reindex', {
    headers: { Cookie: cookieHdr(personas['ADMIN'].cookies), 'X-CSRF-Token': personas['ADMIN'].csrf },
    body: {}
  });
  check('Authorized ADMIN permitted on /api/v2/vector/reindex (proxies to upstream)', adminReindex.status === 200 && adminReindex.data?.stubbed === true);

  // Metallurgist on synthetic generate
  const metGen = await request('POST', '/api/v2/synthetic/generate-synthetic', {
    headers: { Cookie: cookieHdr(personas['METALLURGIST'].cookies), 'X-CSRF-Token': personas['METALLURGIST'].csrf },
    body: { metalGrade: 'SG-IRON' }
  });
  check('Authorized METALLURGIST permitted on /api/v2/synthetic/generate-synthetic', metGen.status === 201 && metGen.data?.status === 'success');

  // Operator on alert simulation in test mode
  const opAlert = await request('POST', '/api/v2/alerts/simulate', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: { grade: 'SG-IRON', severity: 'HIGH' }
  });
  check('Authorized OPERATOR permitted on /api/v2/alerts/simulate in test mode', opAlert.status === 201 && opAlert.data?.status === 'success');

  // TEST SUITE 4: Zero Upstream Network Calls on Rejection
  console.log('\n--- Section 4: Zero Upstream Network Calls on Rejection ---');
  const callsBefore = upstreamCallCount;
  // Send 5 rejected requests
  await request('POST', '/api/v2/ai/agent/analyze', { body: { metalGrade: 'SG-IRON', composition: { C: 3.5 } } });
  await request('POST', '/api/v2/ai/explain', { body: { grade: 'SG-IRON', composition: { C: 3.5 } } });
  await request('POST', '/api/v2/vector/reindex', { body: {} });
  await request('POST', '/api/v2/vector/search', { body: { query: 'test' } });
  await request('POST', '/api/v2/rl/optimize', { body: { grade: 'SG-IRON' } });

  const callsAfter = upstreamCallCount;
  check(`Rejected unauthorized calls dispatched zero upstream HTTP requests (delta: ${callsAfter - callsBefore})`, callsAfter === callsBefore);

  // TEST SUITE 5: Reachable URL Alias Security Parity
  console.log('\n--- Section 5: Reachable URL Alias Security Parity ---');
  const aliasPrefixes = [
    '/api/v2/synthetic/generate-synthetic',
    '/api/v2/api/v1/spectrometer/generate-synthetic',
    '/api/v1/spectrometer/generate-synthetic'
  ];
  for (const aliasPath of aliasPrefixes) {
    const res = await request('POST', aliasPath, { body: { metalGrade: 'SG-IRON' } });
    check(`Spectrometer alias ${aliasPath} rejects anonymous request with 401`, res.status === 401 && res.data?.code === 'UNAUTHORIZED');
  }

  // TEST SUITE 6: Production Mode Restrictions
  console.log('\n--- Section 6: Production Mode Restrictions ---');
  process.env.NODE_ENV = 'production';
  const prodAlert = await request('POST', '/api/v2/alerts/simulate', {
    headers: { Cookie: cookieHdr(personas['ADMIN'].cookies), 'X-CSRF-Token': personas['ADMIN'].csrf },
    body: { grade: 'SG-IRON', severity: 'HIGH' }
  });
  check('Alert simulation permanently disabled in production mode (403 FEATURE_DISABLED)', prodAlert.status === 403 && prodAlert.data?.code === 'FEATURE_DISABLED_IN_ENVIRONMENT');

  const prodSynth = await request('POST', '/api/v2/synthetic/generate-synthetic', {
    headers: { Cookie: cookieHdr(personas['ADMIN'].cookies), 'X-CSRF-Token': personas['ADMIN'].csrf },
    body: { metalGrade: 'SG-IRON' }
  });
  check('Synthetic data generation permanently disabled in production mode (403 FEATURE_DISABLED)', prodSynth.status === 403 && prodSynth.data?.code === 'FEATURE_DISABLED_IN_ENVIRONMENT');

  const prodReset = await request('POST', '/api/v2/premelt/demo/reset', {
    headers: { Cookie: cookieHdr(personas['ADMIN'].cookies), 'X-CSRF-Token': personas['ADMIN'].csrf },
    body: { adminPassword: 'AdminSecurePass123!', confirm: 'DEMO_RESET_CONFIRM' }
  });
  check('Demo reset permanently disabled in production mode (403)', prodReset.status === 403);
  process.env.NODE_ENV = 'test';

  // TEST SUITE 7: CSRF Protection on Cookie Mutations
  console.log('\n--- Section 7: CSRF Protection on Cookie Mutations ---');
  const csrfMissing = await request('POST', '/api/v2/cost/estimate', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies) }, // Missing X-CSRF-Token
    body: { grade: 'SG-IRON', batchWeightKg: 1000 }
  });
  check('Cookie mutation without X-CSRF-Token rejected with 403 CSRF_MISMATCH', csrfMissing.status === 403 && csrfMissing.data?.code === 'CSRF_MISMATCH');

  const csrfValid = await request('POST', '/api/v2/cost/estimate', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: { grade: 'SG-IRON', batchWeightKg: 1000 }
  });
  check('Cookie mutation with matching X-CSRF-Token accepted (200 OK)', csrfValid.status === 200 && csrfValid.data?.status === 'success');

  // TEST SUITE 8: Unchanged State on Rejection
  console.log('\n--- Section 8: Unchanged State on Rejection ---');
  // Record current lots count in SQLite
  const db = getDb();
  const lotsBefore = db.prepare('SELECT count(*) as c FROM lots').get().c;
  // Send unauthorized lot creation attempt
  await request('POST', '/api/v2/premelt/lots', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: { materialType: 'STEEL_SCRAP', receivedKg: 500 }
  });
  const lotsAfter = db.prepare('SELECT count(*) as c FROM lots').get().c;
  check('Zero database mutation: lot count untouched following rejected RBAC attempt', lotsBefore === lotsAfter);

  // TEST SUITE 9: Gun Inspection & Ingest Safe Validation (Fix for 500 ERR_INVALID_ARG_TYPE)
  console.log('\n--- Section 9: Gun Inspect & Ingest-CSV Validation Hardening ---');
  const premeltStore = require('../store');
  premeltStore.addLot({
    lotId: 'LOT-GUN-TEST-001',
    materialType: 'STEEL_SCRAP',
    supplier: 'ScrapYardAlpha',
    receivedKg: 15000,
  }, 'audit_operator');

  // 9a. Inspect with missing lotId returns 400 Bad Request, NOT 500 ERR_INVALID_ARG_TYPE
  const inspectEmpty = await request('POST', '/api/v2/premelt/gun/inspect', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: {}
  });
  check('POST /gun/inspect with empty body fails safely with 400 (not 500)', inspectEmpty.status === 400 && !inspectEmpty.raw.includes('ERR_INVALID_ARG_TYPE') && !inspectEmpty.raw.includes('SQLite'));

  // 9b. Inspect with non-string lotId returns 400
  const inspectNum = await request('POST', '/api/v2/premelt/gun/inspect', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: { lotId: 12345 }
  });
  check('POST /gun/inspect with numeric lotId returns 400', inspectNum.status === 400);

  // 9c. Inspect with valid scrap lot returns 200
  const inspectValid = await request('POST', '/api/v2/premelt/gun/inspect', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: { lotId: 'LOT-GUN-TEST-001' }
  });
  check('POST /gun/inspect with valid lotId starts inspection session (200 OK)', inspectValid.status === 200 && inspectValid.data?.data?.lotId === 'LOT-GUN-TEST-001');

  // 9d. Ingest CSV with missing body returns 400
  const ingestEmpty = await request('POST', '/api/v2/premelt/gun/ingest-csv', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: {}
  });
  check('POST /gun/ingest-csv with empty body fails safely with 400', ingestEmpty.status === 400 && !ingestEmpty.raw.includes('ERR_INVALID_ARG_TYPE'));

  // 9e. Ingest CSV with malformed unparseable CSV returns 400
  const ingestMalformed = await request('POST', '/api/v2/premelt/gun/ingest-csv', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: { csv: 'col1,col2\n"unclosed quote,value2\nval3' }
  });
  check('POST /gun/ingest-csv with malformed CSV format returns 400', ingestMalformed.status === 400 && !ingestMalformed.raw.includes('SQLite'));

  // 9f. Ingest CSV with missing lot_id column returns 400
  const ingestNoLot = await request('POST', '/api/v2/premelt/gun/ingest-csv', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: { csv: 'piece_no,device_id\n1,GUN-01' }
  });
  check('POST /gun/ingest-csv without lot_id returns 400', ingestNoLot.status === 400);

  // 9g. Ingest CSV with valid scrap fixture returns 200 and evaluation decision
  const validCsvFixture = [
    'piece_no,lot_id,device_id,device_type,mode,surface_ok,test_seconds,C,Si,Mn,P,S,Cr,Ni,Mo,Cu,V,Ti,Al,flags',
    '1,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.25,0.40,0.65,0.025,0.025,0.15,0.10,0.02,0.15,0.01,0.01,0.02,',
    '2,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.26,0.39,0.64,0.024,0.026,0.14,0.11,0.02,0.14,0.01,0.01,0.02,',
    '3,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.24,0.41,0.66,0.026,0.024,0.16,0.10,0.02,0.15,0.01,0.01,0.02,',
    '4,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.25,0.40,0.65,0.025,0.025,0.15,0.10,0.02,0.15,0.01,0.01,0.02,',
    '5,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.25,0.40,0.65,0.025,0.025,0.15,0.10,0.02,0.15,0.01,0.01,0.02,',
    '6,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.25,0.40,0.65,0.025,0.025,0.15,0.10,0.02,0.15,0.01,0.01,0.02,',
    '7,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.25,0.40,0.65,0.025,0.025,0.15,0.10,0.02,0.15,0.01,0.01,0.02,',
    '8,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.25,0.40,0.65,0.025,0.025,0.15,0.10,0.02,0.15,0.01,0.01,0.02,',
    '9,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.25,0.40,0.65,0.025,0.025,0.15,0.10,0.02,0.15,0.01,0.01,0.02,',
    '10,LOT-GUN-TEST-001,GUN-01,XRF,Scrap,1,15,0.25,0.40,0.65,0.025,0.025,0.15,0.10,0.02,0.15,0.01,0.01,0.02,'
  ].join('\n');

  const ingestValid = await request('POST', '/api/v2/premelt/gun/ingest-csv', {
    headers: { Cookie: cookieHdr(personas['OPERATOR'].cookies), 'X-CSRF-Token': personas['OPERATOR'].csrf },
    body: { csv: validCsvFixture }
  });
  check('POST /gun/ingest-csv with valid fixture returns 200 and evaluation decision', ingestValid.status === 200 && ingestValid.data?.data?.decision?.status === 'RELEASED');

  // TEST SUITE 10: Reauth Endpoint Contract (Authenticated Contract, NOT Public)
  console.log('\n--- Section 10: Reauth Contract Verification ---');
  // 10a. Anonymous reauth is rejected with 401 UNAUTHORIZED
  const anonReauth = await request('POST', '/api/v2/auth/reauth', { body: { password: 'AdminSecurePass123!' } });
  check('POST /api/v2/auth/reauth rejects anonymous caller with 401 UNAUTHORIZED', anonReauth.status === 401 && anonReauth.data?.code === 'UNAUTHORIZED');

  // 10b. Authenticated reauth with incorrect password returns 401 REAUTH_FAILED
  const badReauth = await request('POST', '/api/v2/auth/reauth', {
    headers: { Cookie: cookieHdr(personas['ADMIN'].cookies), 'X-CSRF-Token': personas['ADMIN'].csrf },
    body: { password: 'WrongPassword999!' }
  });
  check('POST /api/v2/auth/reauth with incorrect password returns 401 REAUTH_FAILED', badReauth.status === 401 && badReauth.data?.code === 'REAUTH_FAILED');

  // 10c. Authenticated reauth with valid password succeeds (200 OK)
  const goodReauth = await request('POST', '/api/v2/auth/reauth', {
    headers: { Cookie: cookieHdr(personas['ADMIN'].cookies), 'X-CSRF-Token': personas['ADMIN'].csrf },
    body: { password: 'AdminSecurePass123!' }
  });
  check('POST /api/v2/auth/reauth with correct password returns 200 OK', goodReauth.status === 200 && goodReauth.data?.status === 'success');

  // TEST SUITE 11: Gateway Outgoing Upstream Scoped Service Authentication
  console.log('\n--- Section 11: Gateway Upstream Scoped Service Header Propagation ---');
  let lastUpstreamHeader = null;
  upstreamStubServer.once('request', (req) => {
    lastUpstreamHeader = req.headers['x-internal-service-key'];
  });
  await request('POST', '/api/v2/vector/reindex', {
    headers: { Cookie: cookieHdr(personas['ADMIN'].cookies), 'X-CSRF-Token': personas['ADMIN'].csrf },
    body: {}
  });
  check('Gateway proxies attach scoped X-Internal-Service-Key to upstream requests', lastUpstreamHeader === 'metallisense-internal-service-secret-key-2026');

  server.close();
  upstreamStubServer.close();

  console.log('\n============================================================');
  console.log(`Remediation Suite Summary: ${passed}/${total} PASSED (All Passed: ${passed === total})`);
  console.log('============================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  if (server) server.close();
  if (upstreamStubServer) upstreamStubServer.close();
  process.exit(1);
});
