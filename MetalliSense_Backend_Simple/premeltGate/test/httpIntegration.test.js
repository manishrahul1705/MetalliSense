const assert = require('assert');
const http = require('http');
const express = require('express');
const { initTestDb, store, createMeltingHeat } = require('./testHelper');
const premelt = require('../routes');
const salesRoutes = require('../salesRoutes');

function makeRequest(serverUrl, { method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'X-Test-User-Id': 'operator1',
        ...headers
      }
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
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  const tests = [];
  initTestDb();

  // Create clean Express test app
  const app = express();
  const { authenticate } = require('../authMiddleware');
  app.use(express.json());
  app.use(authenticate);
  app.use('/api/v2/premelt', premelt.router);
  app.use('/api/v2/sales', salesRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

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

      const res = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: { 'Idempotency-Key': key },
        body: {
          heatId: heat.heatId,
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

      const payload = {
        heatId: heat.heatId,
        lines: [{ lotId: lot.lotId, kg: 15 }]
      };

      const res1 = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: { 'Idempotency-Key': key },
        body: payload
      });
      assert.strictEqual(res1.statusCode, 200);

      // Replay
      const res2 = await makeRequest(baseUrl, {
        method: 'POST',
        path: '/api/v2/premelt/additives/deduct',
        headers: { 'Idempotency-Key': key },
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
        headers: { 'Idempotency-Key': `HTTP-ERR-${Date.now()}` },
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
        headers: { 'Idempotency-Key': `HTTP-404-${Date.now()}` },
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
        headers: { 'X-Test-User-Id': 'qm1' },
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
        headers: { 'X-Test-User-Id': 'qm1' },
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
        headers: { 'X-Test-User-Id': 'qm1' }
      });

      assert.strictEqual(res.statusCode, 409);
      assert(res.data.message.includes('has no approved tap or is in state'));
    });

    await test('TC-HTTP-009: PATCH /sales/config with joint sum > 100% returns 400', async () => {
      const res = await makeRequest(baseUrl, {
        method: 'PATCH',
        path: '/api/v2/sales/config',
        headers: { 'X-Test-User-Id': 'admin1' },
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
        headers: { 'X-Test-User-Id': 'admin1' },
        body: { adminPassword: 'AdminSecurePass123!', confirm: 'DEMO_RESET_CONFIRM' }
      });
      assert.strictEqual(res.statusCode, 403);
      process.env.ENABLE_DEMO_RESET = 'true';
    });

  } finally {
    server.close();
  }

  return tests;
}

if (require.main === module) {
  runTests().then((results) => {
    console.log(JSON.stringify(results, null, 2));
    const failed = results.filter((r) => r.status === 'FAIL');
    process.exit(failed.length > 0 ? 1 : 0);
  });
}

module.exports = { runTests };
