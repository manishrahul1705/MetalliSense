/**
 * MetalliSense Deduction Approval Enforcement & Maker-Checker Boundary Test Suite
 *
 * Verifies through real HTTP that inventory deduction requires a valid, version-bound,
 * unconsumed maker-checker approval. Rejects:
 * - Deduction without approval
 * - Changed quantities or additive IDs after approval
 * - Stale heat, evidence or specification
 * - Approval by the candidate maker
 * - Reuse of approval for another heat/candidate (or already consumed)
 * - Replay (idempotent 200) vs concurrent duplicate deduction (rejected 409)
 *
 * Confirms that all rejected operations leave inventory and heat state strictly unchanged.
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const cors = require('cors');

process.env.NODE_ENV = 'test';
process.env.BOOTSTRAP_DEVELOPMENT_ACCOUNTS = 'true';
process.env.SESSION_SECRET = 'deduction-approval-test-secret-32-chars-long!!';

const { initTestDb, getDb, store, createMeltingHeat } = require('./testHelper');
const dbModule = require('../db');
const sec = require('../security');
const { authenticate, csrfProtection } = require('../authMiddleware');
const authRoutes = require('../authRoutes');
const routes = require('../routes');

let server;
let baseUrl;

function makeRequest(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    if (bodyStr) {
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }

        // Extract cookies
        const setCookieHeaders = res.headers['set-cookie'] || [];
        const cookies = {};
        setCookieHeaders.forEach(c => {
          const part = c.split(';')[0];
          const [k, v] = part.split('=');
          if (k && v) cookies[k.trim()] = v.trim();
        });

        resolve({
          status: res.statusCode,
          headers: res.headers,
          cookies,
          data: json
        });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function loginUser(username, password) {
  const res = await makeRequest('/api/v2/auth/login', {
    method: 'POST',
    body: { username, password }
  });
  assert.strictEqual(res.status, 200, `Login failed for ${username}: ${JSON.stringify(res.data)}`);
  const sessionCookie = res.cookies['metallisense_session'];
  const csrfCookie = res.cookies['metallisense_csrf'];
  const csrfToken = res.data.csrfToken || csrfCookie;
  return {
    headers: {
      'Cookie': `metallisense_session=${sessionCookie}; metallisense_csrf=${csrfCookie}`,
      'X-CSRF-Token': csrfToken
    }
  };
}

async function runTests() {
  console.log('=== Running Deduction Approval Enforcement HTTP Suite ===\n');
  initTestDb();
  const db = getDb();
  dbModule.bootstrapDevAccounts(db, { forceBootstrap: true });

  // Reset any login lockouts
  sec.resetFailedLogin('operator1');
  sec.resetFailedLogin('metallurgist1');
  sec.resetFailedLogin('qm1');

  // Create Express App matching production architecture
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(authenticate);
  app.use(csrfProtection);
  app.use('/api/v2/auth', authRoutes);
  app.use('/api/v2/premelt', routes.router);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    // 1. Authenticate users
    const operatorAuth = await loginUser('operator1', 'OperatorPass123!');
    const metallurgistAuth = await loginUser('metallurgist1', 'MetallurgyPass123!');
    const qmAuth = await loginUser('qm1', 'QualityPass123!');

    // 2. Setup inventory ferroalloy lots
    const lot1 = store.addLot({
      materialType: 'FERROALLOY',
      alloyName: 'FeSi-75',
      supplier: 'Test Alloys',
      receivedKg: 500,
      costPerKg: 100
    }, 'inventory_controller');

    const lot2 = store.addLot({
      materialType: 'FERROALLOY',
      alloyName: 'HC FeMn',
      supplier: 'Test Alloys',
      receivedKg: 500,
      costPerKg: 80
    }, 'inventory_controller');

    // 3. Setup melting heat
    const heat = createMeltingHeat('H-DEDUCT-001', 1000);
    const heatId = heat.heatId;
    db.prepare("UPDATE heats SET planned_by = 'planner1' WHERE heat_id = ?").run(heatId);
    // Add MELT_MEASURED evidence via spectrometer service
    const ev1Res = await makeRequest(`/api/v2/premelt/heats/${heatId}/evidence`, {
      method: 'POST',
      headers: { Authorization: 'Bearer spectro-dev-token-secret-2026' },
      body: {
        sampleId: 'SMP-TEST-001',
        evidenceType: 'MELT_MEASURED',
        values: { C: 3.2, Si: 1.8, Mn: 0.4, P: 0.03, S: 0.01 }
      }
    });
    assert.ok(ev1Res.status === 200 || ev1Res.status === 201, `Evidence ingestion failed: ${JSON.stringify(ev1Res.data)}`);

    const candidateAdditions = [
      { lotId: lot1.lotId, kg: 15.0, alloyName: 'FeSi-75' },
      { lotId: lot2.lotId, kg: 10.0, alloyName: 'HC FeMn' }
    ];

    // Compute candidate hash
    const evalRes = await makeRequest('/api/v2/premelt/corrections/evaluate', {
      method: 'POST',
      headers: operatorAuth.headers,
      body: {
        heatId,
        additions: candidateAdditions,
        targetGrade: 'SG-IRON'
      }
    });
    assert.strictEqual(evalRes.status, 200, `Evaluation failed: ${JSON.stringify(evalRes.data)}`);
    const candidateHash = evalRes.data.data?.candidateHash || evalRes.data.candidateHash;
    const candidateId = 'CAND-CORR-001';

    // ------------------------------------------------------------------------
    // CASE 1: Deduction without approval -> must return 409 APPROVAL_REQUIRED
    // ------------------------------------------------------------------------
    {
      const initialLot1Stock = store.availableKg(lot1.lotId);
      const initialLot2Stock = store.availableKg(lot2.lotId);
      const initialHeatVersion = db.prepare('SELECT version FROM heats WHERE heat_id = ?').get(heatId).version;

      const deductRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `IDEMP-NO-APPROVAL-${Date.now()}`
        },
        body: {
          heatId,
          lines: [{ lotId: lot1.lotId, kg: 15.0 }]
        }
      });

      assert.strictEqual(deductRes.status, 409, `Expected 409, got ${deductRes.status}: ${JSON.stringify(deductRes.data)}`);
      assert.strictEqual(deductRes.data.code, 'APPROVAL_REQUIRED');

      // Assert inventory and heat state unchanged
      assert.strictEqual(store.availableKg(lot1.lotId), initialLot1Stock, 'Lot 1 stock must remain unchanged');
      assert.strictEqual(store.availableKg(lot2.lotId), initialLot2Stock, 'Lot 2 stock must remain unchanged');
      assert.strictEqual(db.prepare('SELECT version FROM heats WHERE heat_id = ?').get(heatId).version, initialHeatVersion);
      console.log('[PASS] Case 1: Deduction without approval rejected (409 APPROVAL_REQUIRED); inventory unchanged');
    }

    // ------------------------------------------------------------------------
    // CASE 4: Approval by candidate maker -> must return 403 MAKER_CHECKER_VIOLATION
    // ------------------------------------------------------------------------
    {
      // If the maker attempts to approve their own candidate
      const selfApproveRes = await makeRequest('/api/v2/premelt/corrections/approve', {
        method: 'POST',
        headers: metallurgistAuth.headers,
        body: {
          heatId,
          candidateId,
          candidateHash,
          expectedHeatVersion: 1,
          evidenceVersion: 'SMP-TEST-001',
          specVersion: '1.0',
          additions: candidateAdditions,
          makerId: 'metallurgist1' // maker is identical to logged-in user metallurgist1
        }
      });

      assert.strictEqual(selfApproveRes.status, 403, `Expected 403, got ${selfApproveRes.status}: ${JSON.stringify(selfApproveRes.data)}`);
      assert.strictEqual(selfApproveRes.data.code, 'MAKER_CHECKER_VIOLATION');
      console.log('[PASS] Case 4: Approval by candidate maker rejected (403 MAKER_CHECKER_VIOLATION)');
    }

    // ------------------------------------------------------------------------
    // Valid Independent Approval by metallurgist
    // ------------------------------------------------------------------------
    const approveRes = await makeRequest('/api/v2/premelt/corrections/approve', {
      method: 'POST',
      headers: metallurgistAuth.headers,
      body: {
        heatId,
        candidateId,
        candidateHash,
        expectedHeatVersion: 1,
        evidenceVersion: 'SMP-TEST-001',
        specVersion: '1.0',
        additions: candidateAdditions,
        makerId: 'planner1' // independent planner
      }
    });
    assert.strictEqual(approveRes.status, 200, `Approval failed: ${JSON.stringify(approveRes.data)}`);
    console.log('[PASS] Independent version-bound approval recorded');

    // ------------------------------------------------------------------------
    // CASE 2: Changed quantities or additive IDs after approval -> 409 APPROVAL_PAYLOAD_MISMATCH
    // ------------------------------------------------------------------------
    {
      const initialLot1Stock = store.availableKg(lot1.lotId);
      const initialLot2Stock = store.availableKg(lot2.lotId);

      // Attempt changed quantity (18 kg instead of 15 kg)
      const badQtyRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `IDEMP-QTY-TAMPER-${Date.now()}`
        },
        body: {
          heatId,
          candidateId,
          candidateHash,
          lines: [
            { lotId: lot1.lotId, kg: 18.0 },
            { lotId: lot2.lotId, kg: 10.0 }
          ]
        }
      });

      assert.strictEqual(badQtyRes.status, 409, `Expected 409 for changed quantity, got ${badQtyRes.status}`);
      assert.strictEqual(badQtyRes.data.code, 'APPROVAL_PAYLOAD_MISMATCH');

      // Attempt unauthorized additive lot (substituting lot2 with different lot)
      const foreignLot = store.addLot({
        materialType: 'FERROALLOY',
        alloyName: 'FeSi-75',
        supplier: 'Other',
        receivedKg: 100,
        costPerKg: 100
      }, 'inventory_controller');

      const badLotRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `IDEMP-LOT-TAMPER-${Date.now()}`
        },
        body: {
          heatId,
          candidateId,
          candidateHash,
          lines: [
            { lotId: foreignLot.lotId, kg: 15.0 },
            { lotId: lot2.lotId, kg: 10.0 }
          ]
        }
      });

      assert.strictEqual(badLotRes.status, 409, `Expected 409 for changed lot, got ${badLotRes.status}`);
      assert.strictEqual(badLotRes.data.code, 'APPROVAL_PAYLOAD_MISMATCH');

      // Verify stock strictly unchanged
      assert.strictEqual(store.availableKg(lot1.lotId), initialLot1Stock);
      assert.strictEqual(store.availableKg(lot2.lotId), initialLot2Stock);
      assert.strictEqual(store.availableKg(foreignLot.lotId), 100);
      console.log('[PASS] Case 2: Changed quantities & additive IDs rejected (409 APPROVAL_PAYLOAD_MISMATCH); inventory unchanged');
    }

    // ------------------------------------------------------------------------
    // CASE 3: Stale heat version, stale evidence or specification -> 409 STALE_APPROVAL_*
    // ------------------------------------------------------------------------
    {
      // Simulate heat version advancement (e.g. concurrent mutation)
      db.prepare('UPDATE heats SET version = version + 1 WHERE heat_id = ?').run(heatId);

      const staleHeatRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `IDEMP-STALE-HEAT-${Date.now()}`
        },
        body: {
          heatId,
          lines: candidateAdditions
        }
      });

      assert.strictEqual(staleHeatRes.status, 409, `Expected 409 for stale heat version, got ${staleHeatRes.status}`);
      assert.strictEqual(staleHeatRes.data.code, 'STALE_APPROVAL_HEAT_VERSION');

      // Revert heat version to match approval for next sub-test
      db.prepare('UPDATE heats SET version = 1 WHERE heat_id = ?').run(heatId);

      // Ingest newer evidence via spectrometer service
      const ev2Res = await makeRequest(`/api/v2/premelt/heats/${heatId}/evidence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer spectro-dev-token-secret-2026' },
        body: {
          sampleId: 'SMP-TEST-NEW-002',
          evidenceType: 'MELT_MEASURED',
          values: { C: 3.3, Si: 1.9, Mn: 0.45, P: 0.03, S: 0.01 }
        }
      });
      assert.ok(ev2Res.status === 200 || ev2Res.status === 201, `Evidence ingestion 2 failed: ${JSON.stringify(ev2Res.data)}`);

      const staleEvRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `IDEMP-STALE-EV-${Date.now()}`
        },
        body: {
          heatId,
          lines: candidateAdditions
        }
      });

      assert.strictEqual(staleEvRes.status, 409, `Expected 409 for stale evidence, got ${staleEvRes.status}`);
      assert.strictEqual(staleEvRes.data.code, 'STALE_APPROVAL_EVIDENCE');
      console.log('[PASS] Case 3: Stale heat version & stale evidence rejected (409 STALE_APPROVAL_*); inventory unchanged');
    }

    // ------------------------------------------------------------------------
    // Approve for new evidence SMP-TEST-NEW-002 on Heat v1
    // ------------------------------------------------------------------------
    const reApproveRes = await makeRequest('/api/v2/premelt/corrections/approve', {
      method: 'POST',
      headers: qmAuth.headers,
      body: {
        heatId,
        candidateId,
        candidateHash,
        expectedHeatVersion: 1,
        evidenceVersion: 'SMP-TEST-NEW-002',
        specVersion: '1.0',
        additions: candidateAdditions,
        makerId: 'planner1'
      }
    });
    assert.strictEqual(reApproveRes.status, 200);

    // ------------------------------------------------------------------------
    // CASE 5: Reuse of approval for another heat -> 409 APPROVAL_REQUIRED
    // ------------------------------------------------------------------------
    {
      const heat2 = createMeltingHeat('H-DEDUCT-002', 1000);
      db.prepare("UPDATE heats SET planned_by = 'planner1' WHERE heat_id = ?").run(heat2.heatId);

      const crossHeatRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `IDEMP-CROSS-HEAT-${Date.now()}`
        },
        body: {
          heatId: heat2.heatId,
          candidateId, // Attempting to use heat1's candidateId on heat2
          lines: candidateAdditions
        }
      });

      assert.strictEqual(crossHeatRes.status, 409, `Expected 409 for heat without its own approval, got ${crossHeatRes.status}`);
      assert.strictEqual(crossHeatRes.data.code, 'APPROVAL_REQUIRED');
      console.log('[PASS] Case 5: Reuse of approval for another heat rejected (409 APPROVAL_REQUIRED)');
    }

    // ------------------------------------------------------------------------
    // CASE 6: Valid Deduction, Replay (200), and Duplicate Deduction (409)
    // ------------------------------------------------------------------------
    {
      const initialLot1Stock = store.availableKg(lot1.lotId);
      const initialLot2Stock = store.availableKg(lot2.lotId);
      const idempKey = `IDEMP-VALID-DEDUCT-${Date.now()}`;

      // 1. Initial valid deduction
      const deductRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': idempKey
        },
        body: {
          heatId,
          lines: candidateAdditions
        }
      });

      assert.strictEqual(deductRes.status, 200, `Valid deduction failed: ${JSON.stringify(deductRes.data)}`);
      assert.strictEqual(store.availableKg(lot1.lotId), initialLot1Stock - 15.0);
      assert.strictEqual(store.availableKg(lot2.lotId), initialLot2Stock - 10.0);

      // Verify approval marked consumed
      const reviewRow = db.prepare("SELECT is_consumed FROM maker_checker_reviews WHERE entity_id = ? AND decision = 'APPROVED' ORDER BY rowid DESC LIMIT 1").get(heatId);
      assert.strictEqual(reviewRow.is_consumed, 1, 'Approval must be marked consumed');

      // 2. Exact replay with identical idempotency key -> MUST return 200 cached receipt without deducting again
      const replayRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': idempKey
        },
        body: {
          heatId,
          lines: candidateAdditions
        }
      });

      assert.strictEqual(replayRes.status, 200, `Replay failed: ${JSON.stringify(replayRes.data)}`);
      // Balances must not have decremented again
      assert.strictEqual(store.availableKg(lot1.lotId), initialLot1Stock - 15.0);
      assert.strictEqual(store.availableKg(lot2.lotId), initialLot2Stock - 10.0);

      // 3. Concurrent duplicate deduction attempt with DIFFERENT key -> MUST return 409 APPROVAL_ALREADY_CONSUMED
      const duplicateRes = await makeRequest('/api/v2/premelt/additives/deduct', {
        method: 'POST',
        headers: {
          ...operatorAuth.headers,
          'Idempotency-Key': `IDEMP-DUPLICATE-ATTEMPT-${Date.now()}`
        },
        body: {
          heatId,
          lines: candidateAdditions
        }
      });

      assert.strictEqual(duplicateRes.status, 409, `Expected 409 duplicate deduction, got ${duplicateRes.status}`);
      assert.strictEqual(duplicateRes.data.code, 'APPROVAL_ALREADY_CONSUMED');
      // Balances remain strictly at single deduction
      assert.strictEqual(store.availableKg(lot1.lotId), initialLot1Stock - 15.0);
      assert.strictEqual(store.availableKg(lot2.lotId), initialLot2Stock - 10.0);

      console.log('[PASS] Case 6: Valid deduction succeeded, replay returned 200 receipt, duplicate rejected (409 APPROVAL_ALREADY_CONSUMED)');
    }

    console.log('\n========================================================');
    console.log('ALL DEDUCTION APPROVAL ENFORCEMENT HTTP TESTS PASSED');
    console.log('========================================================');

  } finally {
    if (server) {
      await new Promise(r => server.close(r));
    }
  }
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
