/**
 * Sales & Dispatch — mounted at /api/v2/sales
 * Secured with least-privilege RBAC, server-owned attribution, and maker-checker separation.
 */
const express = require('express');
const sales = require('./sales');
const { requireAuth, requireRole, requireHuman } = require('./authMiddleware');

const router = express.Router();
const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req, res);
    if (!res.headersSent) res.json({ status: 'success', data });
  } catch (e) {
    const status = e.status || 500;
    const { message, status: _s, stack, ...extra } = e;
    res.status(status).json({ status: status < 500 ? 'fail' : 'error', message, ...extra });
  }
};

// Complete & Disposition Heat (Quality Manager / Admin only)
router.post('/heats/:heatId/complete', requireAuth, requireHuman, requireRole('QUALITY_MANAGER', 'ADMIN'), wrap((req) => sales.completeHeat(req.params.heatId, req.body || {}, req.user)));

// Completed Heats list
router.get('/heats', wrap(() => sales.listCompleted()));

// EN 10204 3.1 Test Certificate (requires authenticated human user)
router.get('/certificates/:heatId', requireAuth, wrap((req) => sales.certificate(req.params.heatId)));

// Customer directory
router.get('/customers', wrap(() => sales.CUSTOMERS));

// Tax Invoices (Sales / Finance / Admin only)
router.get('/invoices', requireAuth, requireRole('SALES_FINANCE', 'ADMIN'), wrap(() => sales.listInvoices()));
router.post('/invoices', requireAuth, requireHuman, requireRole('SALES_FINANCE', 'ADMIN'), wrap((req) => sales.createInvoice(req.body || {}, req.user)));
router.get('/invoices/:id(*)', requireAuth, requireRole('SALES_FINANCE', 'ADMIN'), wrap((req) => sales.getInvoice(req.params.id)));

// Sales Configuration & Material Balance
router.get('/config', wrap(() => sales.getConfig()));
router.patch('/config', requireAuth, requireRole('ADMIN', 'SALES_FINANCE'), wrap((req) => sales.updateConfig(req.body || {})));

module.exports = router;
