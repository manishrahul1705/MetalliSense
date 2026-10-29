// Isolated application fixture for the real-browser Stage 1 regression.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.SEED_DEV_ACCOUNTS = 'true';
process.env.METALLISENSE_DB_PATH = path.join(process.env.EVIDENCE_DIR, 'ui.db');
process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:4392';
const db = require('../db');
const store = require('../store');
const dri = require('../driQa');
const sec = require('../security');
db.initDb();
store.seed(false);
let lot = store.listLots().find(l => l.description === 'Stage1 UI DRI fixture');
if (!lot) {
  lot = store.addLot({ materialType: 'DRI', description: 'Stage1 UI DRI fixture', supplier: 'Stage1 UI supplier', receivedKg: 1000 }, 'fixture');
  const user = sec.getUserByUsername('qm1');
  dri.enter(lot.lotId, { feTotal: 92, feMetallic: 85, C: 1.2, P: 0.03, S: 0.02 }, { userId: user.user_id, username: user.username, displayName: user.display_name });
}
if (!store.heats.get('H-STAGE1-UI')) {
  // This test isolates reading acceptance; physical gate qualification is tested
  // separately. It makes no claim that this fixture passed a furnace gate.
  const now = new Date().toISOString();
  db.getDb().prepare(`INSERT INTO heats (heat_id, grade, target_kg, status, version, charge_json, planned_by, created_at, updated_at)
    VALUES ('H-STAGE1-UI', 'SG-IRON', 1000, 'MELTING', 1, '[]', 'fixture', ?, ?)`).run(now, now);
}
fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'ui-fixture.json'), JSON.stringify({ lotId: lot.lotId, heatId: 'H-STAGE1-UI' }));
const rejectingUpstream = http.createServer((req, res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ detail: 'Downstream authentication fixture rejection' }));
}).listen(0, '127.0.0.1', () => {
  process.env.AGENT_SERVICE_URL = `http://127.0.0.1:${rejectingUpstream.address().port}`;
  process.env.METALLISENSE_AGENT_SERVICE_KEY = crypto.randomBytes(32).toString('hex');
  const { app } = require('../../server');
  const server = app.listen(4391, '127.0.0.1');
  process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); rejectingUpstream.close(); process.exit(0); });
});
