/**
 * Error Handling Narrowing Verification Suite
 *
 * Verifies requirement 5:
 * 1. Return 400 for explicitly validated bad input with helpful client message
 * 2. Keep unexpected internal failures as sanitized 500 responses with redacted server diagnostics
 * 3. Verify zero leakage of SQLite parameters, internal stack traces, or engine internals
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
process.chdir(BACKEND_DIR);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-error-handling-secret';
process.env.METALLISENSE_INTERNAL_SERVICE_KEY = crypto.randomBytes(32).toString('hex');

const { initTestDb, getDb } = require('./testHelper');
const { bootstrapDevAccounts } = require('../db');
const sec = require('../security');
const { app } = require('../../server');

let server;
let baseUrl;

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
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (_) {
          parsed = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed
        });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function run() {
  console.log('============================================================');
  console.log('MetalliSense Error Handling Narrowing Verification');
  console.log('============================================================\n');

  initTestDb();
  bootstrapDevAccounts(getDb(), { forceBootstrap: true });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      console.log(`Test server listening on ${baseUrl}`);
      resolve();
    });
  });

  const loginRes = await request('POST', '/api/v2/auth/login', {
    body: { username: 'admin1', password: 'AdminSecurePass123!' }
  });
  if (!loginRes.headers['set-cookie']) {
    console.error('LOGIN FAILED:', loginRes.status, loginRes.data);
    process.exit(1);
  }
  const setCookieHdrs = Array.isArray(loginRes.headers['set-cookie'])
    ? loginRes.headers['set-cookie']
    : [loginRes.headers['set-cookie']];
  const cookieMap = {};
  setCookieHdrs.forEach((c) => {
    const [kv] = c.split(';');
    const [k, v] = kv.split('=');
    cookieMap[k.trim()] = v.trim();
  });
  const cookieStr = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
  const csrf = cookieMap['metallisense_csrf'];
  const authHeaders = { Cookie: cookieStr, 'X-CSRF-Token': csrf };

  let total = 0;
  let passed = 0;
  function check(desc, ok, extra = '') {
    total++;
    if (ok) {
      passed++;
      console.log(`[PASS] ${desc}`);
    } else {
      console.error(`[FAIL] ${desc} ${extra}`);
    }
  }

  // TEST 1: Explicitly validated bad lotId in /gun/inspect -> 400
  const inspectBad = await request('POST', '/api/v2/premelt/gun/inspect', {
    headers: authHeaders,
    body: { lotId: '' }
  });
  check(
    'Explicitly validated empty lotId returns 400 Bad Request',
    inspectBad.status === 400 && inspectBad.data?.status === 'fail'
  );

  // TEST 2: Missing lotId in /gun/inspect -> 400
  const inspectMissing = await request('POST', '/api/v2/premelt/gun/inspect', {
    headers: authHeaders,
    body: {}
  });
  check(
    'Missing lotId returns 400 Bad Request',
    inspectMissing.status === 400 && inspectMissing.data?.status === 'fail'
  );

  // TEST 3: Explicitly validated bad CSV in /gun/ingest-csv -> 400
  const csvBad = await request('POST', '/api/v2/premelt/gun/ingest-csv', {
    headers: { ...authHeaders, 'Content-Type': 'text/plain' },
    body: ''
  });
  check(
    'Explicitly validated empty CSV payload returns 400 Bad Request',
    csvBad.status === 400 && csvBad.data?.status === 'fail'
  );

  // TEST 4: Missing heatId in /heats/:heatId/charge -> 400 / 404
  const chargeBad = await request('PUT', '/api/v2/premelt/heats/NON-EXISTENT/charge', {
    headers: authHeaders,
    body: { chargeItems: [] }
  });
  check(
    'Non-existent heatId returns 404 Not Found',
    chargeBad.status === 404 && chargeBad.data?.status === 'fail'
  );

  // TEST 5: Unexpected internal error -> 500 with sanitized message and zero diagnostic leak
  // We simulate an unhandled internal engine fault on an endpoint by monkey-patching store temporarily
  const store = require('../store');
  const origList = store.listLots;
  store.listLots = () => {
    const err = new TypeError('Cannot read properties of undefined (reading "internalEngineField")');
    err.code = 'ERR_UNEXPECTED_ENGINE_FAULT';
    throw err;
  };

  const internalErrRes = await request('GET', '/api/v2/premelt/summary', {
    headers: authHeaders
  });

  store.listLots = origList; // restore

  check(
    'Unexpected internal TypeError returns sanitized 500 Internal Server Error',
    internalErrRes.status === 500 && internalErrRes.data?.status === 'error' && internalErrRes.data?.message === 'An unexpected internal error occurred.'
  );

  check(
    'Sanitized 500 does NOT leak stack trace or internal error code',
    internalErrRes.data?.stack === undefined && internalErrRes.data?.code === undefined && !JSON.stringify(internalErrRes.data).includes('internalEngineField')
  );

  server.close();

  console.log('\n============================================================');
  console.log(`Summary: ${passed}/${total} checks passed (${passed === total ? 'ALL PASSED' : 'FAILURES'})`);
  console.log('============================================================\n');

  if (passed !== total) process.exit(1);
  process.exit(0);
}

run().catch((err) => {
  console.error('Test run failed:', err);
  if (server) server.close();
  process.exit(1);
});
