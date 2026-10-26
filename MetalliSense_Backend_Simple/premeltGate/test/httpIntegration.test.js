const assert = require('assert');
const http = require('http');
const express = require('express');
const { initTestDb, getDb, store, createMeltingHeat } = require('./testHelper');
const dbModule = require('../db');
const sec = require('../security');
const { authenticate, csrfProtection } = require('../authMiddleware');
const authRoutes = require('../authRoutes');
const premelt = require('../routes');
const salesRoutes = require('../salesRoutes');

function makeRequest(serverUrl, { method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    if (bodyStr) {
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json
        });
      });
    });

    req.on('error', reject);
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

async function runTests() {
  const tests = [];

  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'http-integration-test-secret-32-chars-long!';

  initTestDb();
  const db = getDb();
  dbModule.bootstrapDevAccounts(db, { forceBootstrap: true });

  // Create clean Express test app with auth, CSRF protection, and routes
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use(csrfProtection);
  app.use('/api/v2/auth', authRoutes);
  app.use('/api/v2/premelt', premelt.router);
  app.use('/api/v2/sales', salesRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function loginUser(username, password) {
    const res = await makeRequest(baseUrl, {
      method: 'POST',
      path: '/api/v2/auth/login',
      body: { username, password }
    });
    assert.strictEqual(res.statusCode, 200, `Login failed for ${username}: ${JSON.stringify(res.data)}`);
    const setCookieHeaders = [].concat(res.headers['set-cookie'] || []);
    const cookies = {};
    setCookieHeaders.forEach((c) => {
      const part = c.split(';')[0];
      const [k, v] = part.split('=');
      if (k && v) cookies[k.trim()] = v.trim();
    });
    const sessionCookie = cookies['metallisense_session'];
    const csrfCookie = cookies['metallisense_csrf'];
    const csrfToken = res.data.csrfToken || csrfCookie;
    return {
      headers: {
        'Cookie': `metallisense_session=${sessionCookie}; metallisense_csrf=${csrfCookie}`,
        'X-CSRF-Token': csrfToken
      }
    };
  }

  // Pre-authenticate sessions for role testing
  const operatorAuth = await loginUser('operator1', 'OperatorPass123!');
  const qmAuth = await loginUser('qm1', 'QualityPass123!');
  const adminAuth = await loginUser('admin1', 'AdminSecurePass123!');

  const test = async (name, fn) => {
    const t0 = Date.now();
    try {
      console.log(`Starting ${name}...`);
      await fn();
      console.log(`Completed ${name} in ${Date.now() - t0}ms`);
      tests.push({ suite: 'httpIntegration', test: name, status: 'PASS', duration_ms: Date.now() - t0 });
    } catch (err) {
      console.log(`Failed ${name}: ${err.message}`);
      tests.push({ suite: 'httpIntegration', test: name, status: 'FAIL', duration_ms: Date.now() - t0, error: err.message });
    }
  };

  try {
    await test('TC-HTTP-001: POST /additives/deduct valid request returns 200', async () => {
      const heat = createMeltingHeat('H-HTTP-001');
      const lot = store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 100, costPerKg: 100 }, 'stores');
      const key = `HTTP-IDEMP-001-${Date.now()}`;

      sec.recordMakerCheckerReview({
        entityType: 'ALLOY_CORRECTION',
        entityId: heat.heatId,
        entityVersion: heat.version,
        makerId: 'operator1',
        checkerId: 'metallurgist1',
        decision: 'APPROVED',
        reason: 'Authorized correction for TC-HTTP-001',
        candidateId: 'CAND-HTTP-001',
        candidateHash: 'HASH-HTTP-001',
        additions: [{ lotId: lot.lotId, kg: 12.5 }]
      });

      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': key
        },
        body: {
          heatId: heat.heatId,
          candidateId: 'CAND-HTTP-001',
          candidateHash: 'HASH-HTTP-001',
          lines: [{ lotId: lot.lotId, kg: 12.5 }]
        }
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.status, 'success');
      assert.strictEqual(res.data.data.deducted[0].deductedKg, 12.5);
    });

    await test('TC-HTTP-002: POST /additives/deduct replay returns 200 with cached receipt', async () => {
      const heat = createMeltingHeat('H-HTTP-002');
      const lot = store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 100, costPerKg: 100 }, 'stores');
      const key = `HTTP-IDEMP-002-${Date.now()}`;

      sec.recordMakerCheckerReview({
        entityType: 'ALLOY_CORRECTION',
        entityId: heat.heatId,
        entityVersion: heat.version,
        makerId: 'operator1',
        checkerId: 'metallurgist1',
        decision: 'APPROVED',
        reason: 'Authorized correction for TC-HTTP-002 replay',
        candidateId: 'CAND-HTTP-002',
        candidateHash: 'HASH-HTTP-002',
        additions: [{ lotId: lot.lotId, kg: 15 }]
      });

      const payload = {
        heatId: heat.heatId,
        candidateId: 'CAND-HTTP-002',
        candidateHash: 'HASH-HTTP-002',
        lines: [{ lotId: lot.lotId, kg: 15 }]
      };

      const res1 = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': key
        },
        body: payload
      });
      assert.strictEqual(res1.statusCode, 200);

      // Replay
      const res2 = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': key
        },
        body: payload
      });
      assert.strictEqual(res2.statusCode, 200);
      assert.strictEqual(store.availableKg(lot.lotId), 85); // deducted only once
    });

    await test('TC-HTTP-003: POST /additives/deduct missing Idempotency-Key returns 400', async () => {
      const heat = createMeltingHeat('H-HTTP-003');
      const lot = store.listLots().find((l) => l.materialType === 'FERROALLOY');

      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: operatorAuth.headers,
        body: {
          heatId: heat.heatId,
          lines: [{ lotId: lot.lotId, kg: 5 }]
        }
      });

      assert.strictEqual(res.statusCode, 400);
      assert(res.data.message.includes('Idempotency-Key'));
    });

    await test('TC-HTTP-004: POST /additives/deduct invalid quantity returns 400', async () => {
      const heat = createMeltingHeat('H-HTTP-004');
      const lot = store.listLots().find((l) => l.materialType === 'FERROALLOY');

      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `HTTP-ERR-${Date.now()}`
        },
        body: {
          heatId: heat.heatId,
          lines: [{ lotId: lot.lotId, kg: -25 }]
        }
      });

      assert.strictEqual(res.statusCode, 400);
    });

    await test('TC-HTTP-005: POST /additives/deduct unknown heat returns 404', async () => {
      const lot = store.listLots().find((l) => l.materialType === 'FERROALLOY');

      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `HTTP-404-${Date.now()}`
        },
        body: {
          heatId: 'H-NOT-FOUND-000',
          lines: [{ lotId: lot.lotId, kg: 5 }]
        }
      });

      assert.strictEqual(res.statusCode, 404);
    });

    await test('TC-HTTP-006: POST /sales/heats/:heatId/complete without measured chemistry returns 422', async () => {
      const heat = createMeltingHeat('H-HTTP-SALE-001');

      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: `/api/v2/sales/heats/${heat.heatId}/complete`,
        headers: qmAuth.headers,
        body: {
          approvedBy: 'engineer_1'
          // no composition provided
        }
      });

      assert.strictEqual(res.statusCode, 422);
      assert(res.data.message.includes('missing or empty'));
    });

    await test('TC-HTTP-007: POST /sales/heats/:heatId/complete with resume:true bypass fails (403)', async () => {
      const heat = createMeltingHeat('H-HTTP-SALE-002');

      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: `/api/v2/sales/heats/${heat.heatId}/complete`,
        headers: qmAuth.headers,
        body: {
          resume: true, // Gate bypass attempt
          approvedBy: 'bypasser'
        }
      });

      assert.strictEqual(res.statusCode, 403);
      assert(res.data.message.includes("The 'resume' flag cannot bypass"));
    });

    await test('TC-HTTP-008: GET /sales/certificates/:heatId on melting heat returns 409', async () => {
      const heat = createMeltingHeat('H-HTTP-CERT-001');

      const res = await makeRequest(baseUrl, {
        method: 'GET',
        path: `/api/v2/sales/certificates/${heat.heatId}`,
        headers: qmAuth.headers
      });

      assert.strictEqual(res.statusCode, 409);
      assert(res.data.message.includes('has no approved tap or is in state'));
    });

    await test('TC-HTTP-009: PATCH /sales/config with joint sum > 100% returns 400', async () => {
      const res = await makeRequest(baseUrl, {
        method: 'PATCH',
        path: '/api/v2/sales/config',
        headers: adminAuth.headers,
        body: {
          castingYieldPct: 75,
          returnsPct: 35 // Sum = 110%
        }
      });

      assert.strictEqual(res.statusCode, 400);
      assert(res.data.message.includes('cannot exceed 100%'));
    });

    await test('TC-HTTP-010: POST /premelt/demo/reset protected when ENABLE_DEMO_RESET != true', async () => {
      process.env.ENABLE_DEMO_RESET = 'false';
      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/demo/reset',
        headers: adminAuth.headers,
        body: { adminPassword: 'AdminSecurePass123!', confirm: 'DEMO_RESET_CONFIRM' }
      });
      assert.strictEqual(res.statusCode, 403);
      process.env.ENABLE_DEMO_RESET = 'true';
    });

    // Explicit anonymous-401 assertions
    await test('TC-HTTP-011: Anonymous request to POST /additives/deduct returns 401 Unauthorized', async () => {
      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: { 'Idempotency-Key': `ANON-DEDUCT-${Date.now()}` },
        body: { heatId: 'H-ANON-001', lines: [] }
      });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.data.code, 'UNAUTHORIZED');
    });

    await test('TC-HTTP-012: Anonymous request to POST /sales/heats/:heatId/complete returns 401 Unauthorized', async () => {
      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/sales/heats/H-ANON-002/complete',
        body: {}
      });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.data.code, 'UNAUTHORIZED');
    });

    await test('TC-HTTP-013: Anonymous request to GET /sales/certificates/:heatId returns 401 Unauthorized', async () => {
      const res = await makeRequest(baseUrl, {
        method: 'GET',
        path: '/api/v2/sales/certificates/H-ANON-003'
      });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.data.code, 'UNAUTHORIZED');
    });

    await test('TC-HTTP-014: Anonymous request to PATCH /sales/config returns 401 Unauthorized', async () => {
      const res = await makeRequest(baseUrl, {
        method: 'PATCH',
        path: '/api/v2/sales/config',
        body: { castingYieldPct: 80 }
      });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.data.code, 'UNAUTHORIZED');
    });

    await test('TC-HTTP-015: Anonymous request to POST /premelt/demo/reset returns 401 Unauthorized', async () => {
      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/demo/reset',
        body: {}
      });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.data.code, 'UNAUTHORIZED');
    });

  } finally {
    if (server.closeAllConnections) {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  }

  return tests;
}

if (require.main === module) {
  runTests().then((results) => {
    console.log(JSON.stringify(results, null, 2));
    const failed = results.filter((r) => r.status === 'FAIL');
    process.exitCode = failed.length > 0 ? 1 : 0;
  });
}

module.exports = { runTests };
