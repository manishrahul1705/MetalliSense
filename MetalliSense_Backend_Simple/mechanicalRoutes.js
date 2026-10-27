/**
 * MetalliSense — Mechanical Property Routes
 * Proxies to the Python AI engine's /mechanical/* endpoints
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth, requireRole } = require('./premeltGate/authMiddleware');

function getAiServiceKey() {
  return (process.env.METALLISENSE_AI_SERVICE_KEY || process.env.METALLISENSE_INTERNAL_SERVICE_KEY || '').trim();
}

const AI_URL = {
  toString() { return process.env.AI_ENGINE_URL || process.env.AI_API_URL || 'http://127.0.0.1:8000'; }
};

router.post('/predict', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), async (req, res) => {
  const serviceKey = getAiServiceKey();
  if (!serviceKey) {
    return res.status(500).json({
      status: 'error',
      code: 'SERVICE_AUTH_UNCONFIGURED',
      message: 'Gateway internal service key for AI service is unconfigured; proxy request blocked.'
    });
  }
  try {
    const { grade, composition, mode = 'formula' } = req.body;
    if (!grade || !composition) {
      return res.status(400).json({ status: 'fail', message: 'grade and composition (C, Si, Mn, P, S) are required' });
    }
    const r = await axios.post(`${AI_URL}/mechanical/predict`, { grade, composition, mode }, {
      headers: {
        'X-Internal-Service-Key': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      }
    });
    res.json({ status: 'success', data: r.data });
  } catch (err) {
    const msg = err.response?.data?.detail || err.message;
    res.status(err.response?.status || 500).json({ status: 'error', message: msg });
  }
});

router.post('/predict/batch', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), async (req, res) => {
  const serviceKey = getAiServiceKey();
  if (!serviceKey) {
    return res.status(500).json({
      status: 'error',
      code: 'SERVICE_AUTH_UNCONFIGURED',
      message: 'Gateway internal service key for AI service is unconfigured; proxy request blocked.'
    });
  }
  try {
    const { items, mode = 'ml' } = req.body;
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ status: 'fail', message: 'items array required' });
    }
    const r = await axios.post(`${AI_URL}/mechanical/predict/batch`, { items, mode }, {
      headers: {
        'X-Internal-Service-Key': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      }
    });
    res.json({ status: 'success', data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ status: 'error', message: err.response?.data?.detail || err.message });
  }
});

router.post('/ce-check', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), async (req, res) => {
  const serviceKey = getAiServiceKey();
  if (!serviceKey) {
    return res.status(500).json({
      status: 'error',
      code: 'SERVICE_AUTH_UNCONFIGURED',
      message: 'Gateway internal service key for AI service is unconfigured; proxy request blocked.'
    });
  }
  try {
    const { grade, composition } = req.body;
    if (!grade || !composition) {
      return res.status(400).json({ status: 'fail', message: 'grade and composition required' });
    }
    const r = await axios.post(`${AI_URL}/mechanical/ce-check`, { grade, composition }, {
      headers: {
        'X-Internal-Service-Key': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      }
    });
    res.json({ status: 'success', data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ status: 'error', message: err.response?.data?.detail || err.message });
  }
});

router.get('/standards', async (req, res) => {
  try {
    const r = await axios.get(`${AI_URL}/mechanical/standards`);
    res.json({ status: 'success', data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ status: 'error', message: err.response?.data?.detail || err.message });
  }
});

router.get('/standards/:grade', async (req, res) => {
  try {
    const r = await axios.get(`${AI_URL}/mechanical/standards/${req.params.grade}`);
    res.json({ status: 'success', data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ status: 'error', message: err.response?.data?.detail || err.message });
  }
});

router.get('/model-info', async (req, res) => {
  try {
    const r = await axios.get(`${AI_URL}/mechanical/model-info`);
    res.json({ status: 'success', data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ status: 'error', message: err.response?.data?.detail || err.message });
  }
});

module.exports = router;
