/**
 * Inventory Forecasting & Reorder — mounted at /api/v2/inventory
 */
const express = require('express');
const inventory = require('./inventory');
const purchaseRequests = require('./purchaseRequests');
const { requireAuth, requireRole } = require('./authMiddleware');

const router = express.Router();
const wrap = (fn) => (req, res) => {
  try {
    res.json({ status: 'success', data: fn(req) });
  } catch (e) {
    res.status(e.status || 500).json({ status: e.status && e.status < 500 ? 'fail' : 'error', message: e.message });
  }
};

router.get('/forecast', wrap(() => inventory.forecastAll()));
router.get('/forecast/:item', wrap((req) => inventory.forecastDetail(req.params.item)));
router.get('/reorder-suggestions', wrap(() => inventory.reorderSuggestions()));

router.get('/purchase-requests', wrap((req) => purchaseRequests.list({ status: req.query.status, item: req.query.item })));
router.post('/purchase-requests', requireAuth, requireRole('INVENTORY_CONTROLLER', 'ADMIN'), wrap((req) => inventory.createPurchaseRequest(req.body || {})));
router.get('/purchase-requests/:id', wrap((req) => {
  const pr = purchaseRequests.get(req.params.id);
  if (!pr) throw Object.assign(new Error(`Purchase request ${req.params.id} not found`), { status: 404 });
  return pr;
}));
router.post('/purchase-requests/:id/approve', requireAuth, requireRole('QUALITY_MANAGER', 'ADMIN'), wrap((req) => purchaseRequests.approve(req.params.id, req.body || {})));
router.post('/purchase-requests/:id/reject', requireAuth, requireRole('QUALITY_MANAGER', 'ADMIN'), wrap((req) => purchaseRequests.reject(req.params.id, req.body || {})));
router.post('/purchase-requests/:id/receive', requireAuth, requireRole('INVENTORY_CONTROLLER', 'ADMIN'), wrap((req) => purchaseRequests.receive(req.params.id, req.body || {})));

router.get('/config', wrap(() => inventory.getConfig()));
router.patch('/config', requireAuth, requireRole('INVENTORY_CONTROLLER', 'ADMIN'), wrap((req) => inventory.updateConfig(req.body || {})));

module.exports = router;
