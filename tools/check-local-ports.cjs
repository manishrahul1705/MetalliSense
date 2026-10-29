// Bind probes only: no process enumeration or termination.
const net = require('node:net');
async function available(port, host) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => resolve(error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL'));
    server.listen({port, host, exclusive:true, ipv6Only:host === '::'}, () => server.close(() => resolve(true)));
  });
}
(async () => {
  const blocked = [];
  for (const port of [3000,4334,4335]) {
    const ipv4 = await available(port,'0.0.0.0');
    const ipv6 = await available(port,'::');
    if (!ipv4 || !ipv6) blocked.push(port);
  }
  if (blocked.length) {
    console.error(`Cannot start local backend: occupied or unavailable ports ${blocked.join(', ')}. Stop your existing backend with Ctrl+C in its terminal, then retry. No process was stopped.`);
    process.exitCode = 1;
  } else console.log('HTTP and OPC UA port preflight passed (3000, 4334, 4335).');
})();
