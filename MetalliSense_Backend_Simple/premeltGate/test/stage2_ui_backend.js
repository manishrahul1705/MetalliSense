// Isolated real application host. No lifecycle state is provisioned here.
const { app } = require('../../server');
const server = app.listen(4391, '127.0.0.1');
// Existing ledger fault seam, controlled only by the owning test process IPC.
// No application endpoint or lifecycle transition is added for testing.
process.on('message', message => {
  const allowed = ['AFTER_FIRST_WRITE', 'BEFORE_COMMIT', 'AFTER_COMMIT_BEFORE_RESPONSE'];
  if (process.env.NODE_ENV !== 'test' || process.env.METALLISENSE_SIMULATION !== 'true'
      || !message || !(message.stage2Fault === null || allowed.includes(message.stage2Fault))) return;
  const ledger = require('../inventoryLedger');
  ledger.__clearTestFaultHook();
  if (message.stage2Fault) ledger.__setTestFaultHook(stage => {
    if (stage === message.stage2Fault) throw new Error(`STAGE2_TEST_FAULT_${stage}`);
  });
  process.send?.({ faultReady: message.id });
});
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); process.exit(0); });
