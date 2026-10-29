// Ported from mechanicalRoutes.js; Node adapters removed.
export default function(module, require) {
/**
 * MetalliSense — Mechanical Property Routes
 * Proxies to the Python AI engine's /mechanical/* endpoints
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');

const AI_URL = 'http://localhost:8000';

router.post('/predict', async (req, res) => {
  try {
    const { grade, composition, mode = 'formula' } = req.body;
    if (!grade || !composition) {
      return res.status(400).json({ status: 'fail', message: 'grade and composition (C, Si, Mn, P, S) are required' });
    }
    const r = await axios.post(`${AI_URL}/mechanical/predict`, { grade, composition, mode });
    res.json({ status: 'success', data: r.data });
  } catch (err) {
    const msg = err.response?.data?.detail || err.message;
    res.status(err.response?.status || 500).json({ status: 'error', message: msg });
  }
});

router.post('/predict/batch', async (req, res) => {
  try {
    const { items, mode = 'ml' } = req.body;
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ status: 'fail', message: 'items array required' });
    }
    const r = await axios.post(`${AI_URL}/mechanical/predict/batch`, { items, mode });
    res.json({ status: 'success', data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ status: 'error', message: err.response?.data?.detail || err.message });
  }
});

router.post('/ce-check', async (req, res) => {
  try {
    const { grade, composition } = req.body;
    if (!grade || !composition) {
      return res.status(400).json({ status: 'fail', message: 'grade and composition required' });
    }
    const r = await axios.post(`${AI_URL}/mechanical/ce-check`, { grade, composition });
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

}
