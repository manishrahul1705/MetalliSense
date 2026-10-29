const assert = require('node:assert/strict');
const express = require('express');
const helper = require('./testHelper');
helper.initTestDb();
const { authenticate, csrfProtection, requireHuman, requireRole } = require('../authMiddleware');
const app = express();app.use(express.json(), authenticate, csrfProtection);
app.use('/auth', require('../authRoutes'));
app.post('/admin-action', requireHuman, requireRole('ADMIN'), (_req,res) => res.json({ok:true}));
app.post('/human-action', requireHuman, requireRole('METALLURGIST'), (_req,res) => res.json({ok:true}));
async function main() {
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(route,headers={})=>fetch(base+route,{method:'POST',headers,signal:AbortSignal.timeout(5000)});
 try {
  process.env.LOCAL_AUTO_LOGIN='true';process.env.NODE_ENV='production';
  assert.equal((await post('/auth/local-session',{Origin:'http://127.0.0.1:5173'})).status,404);
  process.env.NODE_ENV='development';process.env.LOCAL_AUTO_LOGIN='false';
  assert.equal((await post('/auth/local-session',{Origin:'http://127.0.0.1:5173'})).status,404);
  process.env.LOCAL_AUTO_LOGIN='true';
  assert.equal((await post('/auth/local-session',{Origin:'https://unrelated.example'})).status,403);
  assert.equal((await post('/auth/local-session')).status,403);
  const response=await post('/auth/local-session',{Origin:'http://127.0.0.1:5173'});assert.equal(response.status,200);
  const body=await response.json();assert.deepEqual(body.data.user.roles,['METALLURGIST']);
  const cookies=response.headers.getSetCookie().map(v=>v.split(';')[0]);const cookie=cookies.join('; ');
  const csrf=cookies.find(v=>v.startsWith('metallisense_csrf=')).split('=')[1];
  assert.equal((await post('/human-action',{Cookie:cookie})).status,403);
  assert.equal((await post('/human-action',{Cookie:cookie,Authorization:'Bearer invalid'})).status,403);
  assert.equal((await post('/human-action',{Cookie:cookie,'X-CSRF-Token':csrf})).status,200);
  assert.equal((await post('/admin-action',{Cookie:cookie,'X-CSRF-Token':csrf})).status,403);
  assert.equal(body.data.user.displayName,'Metallurgist');
  console.log('PASS local auto-login: explicit opt-in, production disabled, origin required, real metallurgist session and CSRF enforced');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));helper.closeDb();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
