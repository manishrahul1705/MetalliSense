/**
 * Supplier Scorecard + Energy routes — mounted at /api/v2/insights
 */
const express = require('express');
const store = require('./store');
const scorecard = require('./supplierScorecard');
const energy = require('./energy');
const { requireAuth, requireRole } = require('./authMiddleware');

const router = express.Router();
const ok = (res, data) => res.json({ status: 'success', data });
const fail = (res, e) => res.status(e.status || 500).json({ status: 'fail', message: e.message, ...(e.ahp ? { ahp: e.ahp } : {}) });
const wrap = (fn) => (req, res) => { try { ok(res, fn(req)); } catch (e) { fail(res, e); } };

// ---------------------------------------------------------------- suppliers
router.get('/suppliers/scorecard', wrap((req) => scorecard.computeScorecard({ materialType: req.query.materialType || undefined })));
router.get('/suppliers/detail', wrap((req) => {
  const s = scorecard.supplierDetail(req.query.name, req.query.materialType || undefined);
  if (!s) throw Object.assign(new Error(`Supplier ${req.query.name} not found`), { status: 404 });
  return s;
}));
router.get('/suppliers/lot-grade/:lotId', wrap((req) => {
  const lot = store.getLot(req.params.lotId);
  if (!lot) throw Object.assign(new Error(`Lot ${req.params.lotId} not found`), { status: 404 });
  return { lotId: lot.lotId, supplier: lot.supplier, ...(scorecard.gradeForLot(lot) || { grade: 'NEW', inspectPieces: 25 }) };
}));
router.get('/suppliers/best', wrap((req) => scorecard.bestSupplierFor(req.query.materialType, req.query.alloyName)));
router.patch('/suppliers/weights', requireAuth, requireRole('METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), wrap((req) => scorecard.updateWeights(req.body || {})));
// AHP pairwise judgements between Quality, Cost, Delivery and Service → pillar weights.
router.get('/suppliers/ahp', wrap(() => scorecard.getAhp()));
router.patch('/suppliers/ahp', requireAuth, requireRole('METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), wrap((req) => scorecard.updateAhp(req.body || {})));
// Order split: how to divide the next purchase between suppliers.
router.get('/suppliers/order-plan', wrap((req) => scorecard.orderPlan(req.query.materialType, req.query.tonnes)));
// Supplier alerts only (grade drops, declining trend, hidden cost, blocked suppliers).
router.get('/suppliers/alerts', wrap((req) => scorecard.computeScorecard({ materialType: req.query.materialType || undefined }).alerts));

// ---------------------------------------------------------------- energy
router.get('/energy/config', wrap(() => energy.getConfig()));
router.patch('/energy/config', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), wrap((req) => energy.updateConfig(req.body || {})));
router.get('/energy/summary', wrap(() => energy.summary()));
router.get('/energy/heat/:heatId', wrap((req) => {
  const heat = store.heats.get(req.params.heatId);
  if (!heat) throw Object.assign(new Error(`Heat ${req.params.heatId} not found`), { status: 404 });
  const { tapTempC, holdingMin, hour } = req.query;
  return energy.predictHeat(heat, { tapTempC, holdingMin, hour });
}));
router.post('/energy/heat/:heatId/actual', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), wrap((req) => energy.recordActual(req.params.heatId, req.body || {})));
router.post('/energy/heat/:heatId/simulate', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), wrap((req) => energy.simulateActual(req.params.heatId, req.body?.by)));

module.exports = router;
