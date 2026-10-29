// Read-only source AST inventory. No application module is imported or started.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const espree = require(path.join(root, 'MetalliSense_Frontend_R/MetalliSense_Frontend/node_modules/espree'));
const output = process.argv[2];
if (!output || fs.existsSync(output)) throw new Error('A new output path is required');
const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/)
  .filter(f => f.startsWith('MetalliSense_Backend_Simple/') && f.endsWith('.js') && !f.includes('/test/'));
const endpoints = [], mounts = [], globalGuards = new Map(), unresolved = [];
function walk(n, fn) { if (!n || typeof n !== 'object') return; if (n.type) fn(n); for (const [k, v] of Object.entries(n)) if (!['loc', 'range', 'parent'].includes(k)) { if (Array.isArray(v)) v.forEach(x => walk(x, fn)); else if (v && typeof v === 'object') walk(v, fn); } }
const literal = n => n?.type === 'Literal' && typeof n.value === 'string' ? n.value : null;
function guard(args) {
  const result = { requireAuth: false, requireHuman: false, roles: [], devOnly: false };
  for (const a of args) {
    if (a?.type === 'Identifier') { if (a.name in result) result[a.name] = true; }
    if (a?.type === 'CallExpression' && a.callee?.name === 'requireRole') result.roles.push(...a.arguments.map(literal).filter(Boolean));
    if (a?.type === 'CallExpression' && a.callee?.name === 'requireDevOrTest') result.devOnly = true;
  }
  return result;
}
for (const file of [...new Set(files)]) {
  const absolute = path.join(root, file), source = fs.readFileSync(absolute, 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true, range: true });
  const aliases = new Map(), routers = new Set();
  walk(ast, n => { if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier') {
    aliases.set(n.id.name, n.init);
    if (n.init?.type === 'CallExpression' && n.init.callee?.property?.name === 'Router') routers.add(n.id.name);
  } });
  const key = name => `${file}|${name}`;
  function target(n) {
    if (n?.type === 'Identifier') {
      if (routers.has(n.name)) return key(n.name);
      const init = aliases.get(n.name); if (init) return target(init);
    }
    if (n?.type === 'MemberExpression') return target(n.object);
    if (n?.type === 'CallExpression' && n.callee?.name === 'require' && literal(n.arguments[0])?.startsWith('.')) {
      let f = path.resolve(path.dirname(absolute), literal(n.arguments[0]));
      if (fs.existsSync(f + '.js')) f += '.js';
      return `${path.relative(root, f).replaceAll('\\', '/')}|router`;
    }
    return null;
  }
  walk(ast, n => {
    if (n.type !== 'CallExpression' || n.callee?.type !== 'MemberExpression' || n.callee.object?.type !== 'Identifier') return;
    const receiver = n.callee.object.name, method = n.callee.property.name;
    if (!(routers.has(receiver) || (file === 'MetalliSense_Backend_Simple/server.js' && receiver === 'app'))) return;
    if (['get','post','put','patch','delete'].includes(method)) {
      const declaredPath = literal(n.arguments[0]);
      if (declaredPath === null) { unresolved.push({ file, line: n.loc.start.line, reason: 'Nonliteral route path' }); return; }
      endpoints.push({ file, line: n.loc.start.line, key: key(receiver), method: method.toUpperCase(), declaredPath,
        ...guard(n.arguments.slice(1)), declaration: source.slice(n.range[0], Math.min(n.range[0] + 240, n.range[1])) });
    } else if (method === 'use') {
      const prefix = literal(n.arguments[0]);
      if (prefix !== null) {
        for (const a of n.arguments.slice(1)) { const child = target(a); if (child) mounts.push({ parent: key(receiver), child, prefix, file, line: n.loc.start.line }); }
      } else {
        const g = guard(n.arguments); globalGuards.set(key(receiver), g);
      }
    }
  });
}
const reachable = [];
function expand(key, prefix, parents = []) {
  if (parents.includes(key)) throw new Error('Router mount cycle');
  const inherited = globalGuards.get(key) || {};
  for (const e of endpoints.filter(e => e.key === key)) reachable.push({ ...e,
    requireAuth: e.requireAuth || inherited.requireAuth || false,
    requireHuman: e.requireHuman || inherited.requireHuman || false,
    roles: [...new Set([...(inherited.roles || []), ...e.roles])],
    path: prefix + (e.declaredPath === '/' ? '' : e.declaredPath), mount: prefix });
  for (const m of mounts.filter(m => m.parent === key)) expand(m.child, prefix + m.prefix, [...parents, key]);
}
expand('MetalliSense_Backend_Simple/server.js|app', '');
const mutationDeclarations = endpoints.filter(e => e.method !== 'GET' && reachable.some(r => r.file === e.file && r.line === e.line));
const mutations = reachable.filter(r => r.method !== 'GET');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ head: cp.execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding:'utf8' }).trim(),
  summary: { declarations: endpoints.length, mutationDeclarations: mutationDeclarations.length, reachableMutationAliases: mutations.length },
  mounts, unresolved, mutations, reachable }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ declarations: endpoints.length, mutationDeclarations: mutationDeclarations.length, reachableMutationAliases: mutations.length, unresolved: unresolved.length }));
if (unresolved.length) process.exitCode = 1;
