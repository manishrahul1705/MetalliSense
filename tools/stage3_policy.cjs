// Expected permission policy reviewed separately from AST/runtime extraction.
// Basis: role responsibilities in authMiddleware/security, original Stage 1B
// expected-role tests, and service-vs-human evidence contract. No route guard
// metadata or observed response is used to calculate an expected permission.
const H = ['OPERATOR','METALLURGIST','QUALITY_MANAGER','INVENTORY_CONTROLLER','SALES_FINANCE','ADMIN','VIEWER'];
const P = {};
function allow(method, paths, roles) { for (const p of paths.split(' ')) P[`${method} ${p}`] = roles.split(','); }
allow('POST','/api/v2/auth/login /api/v2/auth/logout','PUBLIC');
allow('POST','/api/v2/auth/reauth /api/v2/premelt/corrections/evaluate','HUMAN');
allow('POST','/api/v2/alerts/send-email /api/v2/alerts/simulate /api/v2/ai/anomaly/predict /api/v2/ai/individual/analyze /api/v2/ai/agent/analyze /api/v2/ai/explain /api/v2/ai/analyze-with-explanation /api/v2/vector/search /api/v2/mechanical/predict /api/v2/mechanical/predict/batch /api/v2/mechanical/ce-check','OPERATOR,METALLURGIST,QUALITY_MANAGER,ADMIN');
allow('POST','/api/v2/workflow/full-analysis /api/v2/ai/what-if /api/v2/rl/optimize /api/v2/rl/feedback /api/v2/vector/memory/add /api/v2/vector/memory/recall /api/v2/premelt/heats /api/v2/premelt/heats/:heatId/gate-check /api/v2/premelt/heats/:heatId/start-melting /api/v2/insights/energy/heat/:heatId/actual /api/v2/insights/energy/heat/:heatId/simulate','OPERATOR,METALLURGIST,ADMIN');
allow('PUT','/api/v2/premelt/heats/:heatId/charge','OPERATOR,METALLURGIST,ADMIN');
allow('POST','/api/v2/training-data /api/v2/grades','METALLURGIST,ADMIN');
allow('PATCH','/api/v2/training-data/:id /api/v2/grades/:id /api/v2/carbon/factors /api/v2/premelt/config','METALLURGIST,ADMIN');
allow('DELETE','/api/v2/training-data/:id /api/v2/grades/:id','METALLURGIST,ADMIN');
allow('POST','/api/v2/vector/reindex /api/v2/premelt/demo/reset','ADMIN');
allow('PATCH','/api/v2/cost/prices /api/v2/cost/selling-prices /api/v2/sales/config','SALES_FINANCE,ADMIN');
allow('POST','/api/v2/cost/estimate /api/v2/carbon/estimate','OPERATOR,METALLURGIST,SALES_FINANCE,ADMIN');
allow('POST','/api/v2/premelt/lots /api/v2/premelt/lots/:lotId/adjust /api/v2/premelt/additives/receive /api/v2/inventory/purchase-requests /api/v2/inventory/purchase-requests/:id/receive','INVENTORY_CONTROLLER,ADMIN');
allow('PATCH','/api/v2/inventory/config','INVENTORY_CONTROLLER,ADMIN');
allow('PATCH','/api/v2/premelt/lots/:lotId/status','QUALITY_MANAGER,ADMIN');
allow('POST','/api/v2/premelt/dri-qa/:qaId/approve /api/v2/premelt/dri-qa/:qaId/reject /api/v2/inventory/purchase-requests/:id/approve /api/v2/inventory/purchase-requests/:id/reject /api/v2/sales/heats/:heatId/complete','QUALITY_MANAGER,ADMIN');
allow('POST','/api/v2/premelt/additives/deduct','OPERATOR,METALLURGIST,INVENTORY_CONTROLLER,ADMIN');
allow('POST','/api/v2/premelt/corrections/approve','METALLURGIST,QUALITY_MANAGER,ADMIN');
allow('POST','/api/v2/premelt/lots/:lotId/dri-qa','QUALITY_MANAGER,LAB_SERVICE,ADMIN');
allow('POST','/api/v2/premelt/gun/connect /api/v2/premelt/gun/disconnect /api/v2/premelt/gun/inspect /api/v2/premelt/gun/argon/replace','OPERATOR,INVENTORY_CONTROLLER,ADMIN');
allow('POST','/api/v2/premelt/gun/ingest-csv','OPERATOR,INVENTORY_CONTROLLER,GUN_SERVICE,ADMIN');
allow('PATCH','/api/v2/insights/suppliers/weights /api/v2/insights/suppliers/ahp','METALLURGIST,QUALITY_MANAGER,ADMIN');
allow('PATCH','/api/v2/insights/energy/config','OPERATOR,METALLURGIST,QUALITY_MANAGER,ADMIN');
allow('POST','/api/v2/sales/invoices','SALES_FINANCE,ADMIN');
function policy(route, variant) {
  const normalized = route.path.replace(/^\/api\/v2\/api\/v1\/spectrometer|^\/api\/v1\/spectrometer|^\/api\/v2\/spectrometer|^\/api\/v2\/synthetic/, '/instrument');
  let roles = P[`${route.method} ${normalized}`];
  if (normalized.startsWith('/instrument')) {
    if (/\/opc-(connect|disconnect|reading)$/.test(normalized)) roles = ['OPERATOR','METALLURGIST','ADMIN'];
    else roles = route.method === 'DELETE' ? ['ADMIN'] : ['METALLURGIST','ADMIN'];
  }
  if (route.path.endsWith('/heats/:heatId/evidence')) roles = variant === 'chemistry' ? ['SPECTROMETER_SERVICE'] : ['QUALITY_MANAGER','ADMIN','LAB_SERVICE'];
  if (!roles) throw new Error(`Unreviewed policy: ${route.method} ${route.path}`);
  return roles;
}
function permitted(roles, principal) {
  if (roles.includes('PUBLIC')) return true;
  if (principal.kind === 'human') return roles.includes('HUMAN') || roles.includes(principal.role);
  return principal.kind === 'service' && roles.includes(principal.role);
}
module.exports = { H, policy, permitted, explicitPolicies: P };
