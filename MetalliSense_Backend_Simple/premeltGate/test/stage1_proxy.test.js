const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../../..');
const directory = fs.mkdtempSync(path.join(process.env.EVIDENCE_DIR || os.tmpdir(), 'proxy-'));
const key = crypto.randomBytes(32).toString('hex');
const machineKey = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
process.env.METALLISENSE_DB_PATH = path.join(directory, 'proxy.db');
process.env.METALLISENSE_AGENT_SERVICE_KEY = key;
process.env.METALLISENSE_INTERNAL_SERVICE_KEY = '';
let agent, server;
const deadline = setTimeout(() => { console.error('FAIL: proxy overall deadline'); agent?.kill(); process.exit(1); }, 180000);
async function main() {
  assert.ok(process.env.STAGE1_AGENT_PYTHON, 'STAGE1_AGENT_PYTHON must identify a provisioned Python environment');
  const reservation = net.createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  process.env.AGENT_SERVICE_URL = `http://127.0.0.1:${port}`;
  const source = path.join(root, 'MetalliSense_Agent_R/MetalliSense_Agent/app');
  const runtime = path.join(directory, 'agent-runtime');
  fs.cpSync(source, path.join(runtime, 'app'), { recursive: true, filter: name => !name.includes('__pycache__') });
  async function startAgent(fixture) {
  const log = fs.openSync(path.join(directory, fixture ? 'agent.log' : 'agent-provider-blocked.log'), 'w');
  agent = spawn(process.env.STAGE1_AGENT_PYTHON, [path.join(root, 'tools/stage1_agent_fixture.py'), runtime, String(port)], {
    cwd: runtime, env: { ...process.env, STAGE1_EXTERNAL_LLM_FIXTURE: String(fixture), PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', GROQ_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' }, stdio: ['ignore', log, log], windowsHide: true
  });
  const end = Date.now() + 90000;
  while (true) {
    try { const r = await fetch(`${process.env.AGENT_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) break; } catch (_) {}
    if (agent.exitCode !== null || Date.now() > end) throw new Error('Actual Agent failed readiness; see retained agent.log');
    await new Promise(r => setTimeout(r, 300));
  }
  }
  await startAgent(false);
  const providerBlocked = await fetch(`${process.env.AGENT_SERVICE_URL}/copilot/explain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': key },
    body: JSON.stringify({ grade: 'SG-IRON', composition: { C: 3.5, Si: 2.2, Mn: 0.35, P: 0.02, S: 0.01 } }), signal: AbortSignal.timeout(35000)
  });
  assert.equal(providerBlocked.status, 503, 'No provider credentials: actual explanation must be blocked');
  console.log('PROVIDER-BLOCKED: actual Agent explanation returns 503 without a provider key');
  const stopped = new Promise(resolve => agent.once('exit', resolve));
  agent.kill(); await stopped;
  await startAgent(true);
  const sec = require('../security');
  const db = require('../db');
  db.initDb();
  sec.createUser({ userId: 'STAGE1-OP', username: 'stage1-op', displayName: 'Stage1 Operator', email: 'stage1-op@example.invalid', password: crypto.randomBytes(32).toString('hex'), roles: ['OPERATOR'] });
  sec.createUser({ userId: 'STAGE1-FIN', username: 'stage1-fin', displayName: 'Stage1 Finance', email: 'stage1-fin@example.invalid', password: crypto.randomBytes(32).toString('hex'), roles: ['FINANCE'] });
  sec.createServiceCredential({ serviceId: 'STAGE1-MACHINE', serviceName: 'Test instrument', serviceType: 'SPECTROMETER_SERVICE', apiKey: machineKey });
  const axios = require('axios');
  const adapter = axios.getAdapter(axios.defaults.adapter);
  let calls = 0;
  axios.defaults.adapter = config => {
    calls++;
    assert.equal(config.headers['X-Internal-Service-Key'], process.env.METALLISENSE_AGENT_SERVICE_KEY);
    assert.equal(config.headers.Authorization, `Bearer ${process.env.METALLISENSE_AGENT_SERVICE_KEY}`);
    assert.equal(config.timeout, config.url.endsWith('/feedback') ? 3000 : 30000);
    return adapter(config);
  };
  const { app } = require('../../server');
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const composition = { Fe: 94, C: 3.5, Si: 2.2, Mn: 0.35, P: 0.02, S: 0.01 };
  const fixtures = [
    ['/api/v2/ai/explain', { metalGrade: 'SG-IRON', composition }],
    ['/api/v2/rl/optimize', { grade: 'SG-IRON', composition, topK: 3 }],
    ['/api/v2/rl/feedback', { grade: 'SG-IRON', composition, additions: { FeSi: 0.1 }, outcome: 'accepted', actualResult: composition, operatorNote: 'SIMULATED test feedback' }]
  ];
  async function request(route, body, headers = {}) {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
    return { status: r.status, data: await r.json() };
  }
  for (const [route, body] of fixtures) {
    let count = calls;
    assert.equal((await request(route, body)).status, 401);
    assert.equal((await request(route, body, { 'x-test-user-id': 'STAGE1-FIN' })).status, 403);
    assert.equal((await request(route, body, { Authorization: `Bearer ${machineKey}` })).status, 403);
    assert.equal(calls, count, 'gateway rejections must not dispatch');
    process.env.METALLISENSE_AGENT_SERVICE_KEY = '';
    assert.equal((await request(route, body, { 'x-test-user-id': 'STAGE1-OP' })).data.code, 'SERVICE_AUTH_UNCONFIGURED');
    assert.equal(calls, count, 'unconfigured gateway must not dispatch');
    process.env.METALLISENSE_AGENT_SERVICE_KEY = 'wrong-isolated-fixture-key';
    const rejected = await request(route, body, { 'x-test-user-id': 'STAGE1-OP' });
    assert.equal(rejected.status, 502);
    assert.equal(rejected.data.code, 'UPSTREAM_AUTH_REJECTED');
    assert.equal(calls, ++count, 'wrong credentials must reach and be rejected by actual Agent');
    process.env.METALLISENSE_AGENT_SERVICE_KEY = key;
    const accepted = await request(route, body, { 'x-test-user-id': 'STAGE1-OP', 'X-Internal-Service-Key': 'caller-secret-must-not-forward' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.equal(calls, ++count);
    if (route.endsWith('/explain')) assert.match(accepted.data.data.geminiExplanation.explanation, /SIMULATED/);
    if (route.endsWith('/optimize')) assert.ok(accepted.data.data.candidates.length > 0);
    if (route.endsWith('/feedback')) assert.equal(accepted.data.accepted, true);
    console.log(`PASS ${route}: gateway guards, zero-dispatch, scope, actual Agent rejection and success (${route.endsWith('/explain') ? 'external LLM fixture' : 'real Agent RL handler; synthetic input'})`);
  }
}
main().then(() => finish(0)).catch(error => { console.error(error.message); finish(1); });
function finish(code) { clearTimeout(deadline); server?.closeAllConnections(); server?.close(); agent?.kill(); setTimeout(() => process.exit(code), 300); }
