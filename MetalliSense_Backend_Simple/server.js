/**
 * MetalliSense — Simple Backend
 * No login, no database. Everything is served from dataset.csv in memory.
 * This is a separate, standalone backend from your original project.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

const express = require('express');
const cors = require('cors');
const store = require('./csvDataStore');
const gradeStore = require('./gradeSpecStore');
const opcuaService = require('./opcuaService');
const priceStore = require('./alloyPriceStore');
const emailService = require('./emailService');
const carbonStore = require('./carbonStore');
const sellingPriceStore = require('./sellingPriceStore');
const mechanicalRoutes = require('./mechanicalRoutes');

const app = express();
const { authenticate, csrfProtection, requireAuth, requireRole, requireDevOrTest } = require('./premeltGate/authMiddleware');
const authRoutes = require('./premeltGate/authRoutes');

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const defaultAllowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4179',
  'http://127.0.0.1:4179',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];

const corsOriginWhitelist = allowedOrigins.length > 0 ? allowedOrigins : defaultAllowedOrigins;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (corsOriginWhitelist.includes(origin)) return callback(null, true);
    return callback(new Error('CORS policy: Origin ' + origin + ' is not allowed'), false);
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(authenticate);
app.use(csrfProtection);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use('/api/v2/auth', authRoutes);

const port = process.env.PORT || 3000;

// Start the OPC UA server (simulated spectrometer) as soon as the process
// boots. The client side only connects when asked via the API, matching
// the original project's "server ready, client pending" behavior.
opcuaService.initializeServerOnly().then((ok) => {
  console.log(ok ? '✅ OPC UA Server ready (Client connection pending)' : '❌ OPC UA Server failed to initialize');
});

// -------- Health --------
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'success', message: 'Server is running!', timestamp: new Date().toISOString() });
});

// ======================= OWNER EMAIL ALERTS =======================
app.get('/api/v2/alerts/email-status', (req, res) => {
  res.json({
    status: 'success',
    data: {
      configured: emailService.isConfigured(),
      triggerSeverities: ['MEDIUM', 'HIGH', 'moderate', 'severe'],
      note: emailService.isConfigured()
        ? 'Ready to send real emails.'
        : 'Set GMAIL_USER, GMAIL_APP_PASSWORD, and OWNER_EMAIL in config.env to enable.',
    },
  });
});

app.post('/api/v2/alerts/send-email', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), async (req, res) => {
  const { grade, severity, composition, recommendedAdditions, batchId, costDetails } = req.body;
  if (!grade || !severity || !composition) {
    return res.status(400).json({ status: 'fail', message: 'grade, severity, and composition are required' });
  }
  const result = await emailService.sendDeviationAlertEmail({ grade, severity, composition, recommendedAdditions, batchId, costDetails });
  res.status(result.sent ? 200 : 502).json({ status: result.sent ? 'success' : 'error', data: result });
});


// ======================= TRAINING DATA =======================
const trainingData = express.Router();

trainingData.get('/paginated', (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;

  let data = store.getAll();
  if (req.query.grade) data = data.filter((r) => r.grade === req.query.grade.toUpperCase());
  if (req.query.sample_type) data = data.filter((r) => r.sample_type === req.query.sample_type);
  if (req.query.severity) data = data.filter((r) => r.severity === req.query.severity);

  const sortBy = req.query.sort || '-createdAt';
  const sortField = sortBy.replace('-', '');
  const sortDir = sortBy.startsWith('-') ? -1 : 1;
  data = [...data].sort((a, b) => {
    if (a[sortField] === b[sortField]) return 0;
    return a[sortField] > b[sortField] ? sortDir : -sortDir;
  });

  const totalDocuments = data.length;
  const totalPages = Math.ceil(totalDocuments / limit) || 1;
  const skip = (page - 1) * limit;
  const pageData = data.slice(skip, skip + limit);

  res.json({
    status: 'success',
    results: pageData.length,
    pagination: {
      currentPage: page, totalPages, totalDocuments, limit,
      hasNextPage: page < totalPages, hasPrevPage: page > 1,
      nextPage: page < totalPages ? page + 1 : null,
      prevPage: page > 1 ? page - 1 : null,
    },
    data: { trainingData: pageData },
  });
});

trainingData.get('/visualizations', (req, res) => {
  const all = store.getAll();
  const elements = ['Fe', 'C', 'Si', 'Mn', 'P', 'S'];
  const byGrade = {};
  all.forEach((r) => { (byGrade[r.grade] ||= []).push(r); });

  const gradeDistribution = Object.entries(byGrade)
    .map(([grade, rows]) => ({
      _id: grade, total: rows.length,
      normal: rows.filter((r) => r.sample_type === 'normal').length,
      deviated: rows.filter((r) => r.sample_type === 'deviated').length,
    }))
    .sort((a, b) => b.total - a.total);

  const sampleTypeCounts = {};
  const severityCounts = {};
  all.forEach((r) => {
    sampleTypeCounts[r.sample_type] = (sampleTypeCounts[r.sample_type] || 0) + 1;
    severityCounts[r.severity] = (severityCounts[r.severity] || 0) + 1;
  });

  const compositionByGrade = Object.entries(byGrade).map(([grade, rows]) => {
    const entry = { _id: grade, totalSamples: rows.length };
    elements.forEach((el) => {
      const values = rows.map((r) => r[el]);
      entry[`avg${el}`] = values.reduce((a, b) => a + b, 0) / values.length;
      entry[`min${el}`] = Math.min(...values);
      entry[`max${el}`] = Math.max(...values);
    });
    return entry;
  });

  const overview = {
    totalSamples: all.length,
    normalSamples: all.filter((r) => r.sample_type === 'normal').length,
    deviatedSamples: all.filter((r) => r.sample_type === 'deviated').length,
    severityNone: all.filter((r) => r.severity === 'none').length,
    severityMild: all.filter((r) => r.severity === 'mild').length,
    severityModerate: all.filter((r) => r.severity === 'moderate').length,
    severitySevere: all.filter((r) => r.severity === 'severe').length,
  };

  res.json({
    status: 'success',
    data: {
      overview,
      gradeDistribution,
      sampleTypeDistribution: Object.entries(sampleTypeCounts).map(([_id, count]) => ({ _id, count })),
      severityDistribution: Object.entries(severityCounts).map(([_id, count]) => ({ _id, count })),
      compositionByGrade,
    },
  });
});

trainingData.get('/grade/:gradeName/statistics', (req, res) => {
  const grade = req.params.gradeName.toUpperCase();
  const rows = store.getAll().filter((r) => r.grade === grade);
  if (rows.length === 0) {
    return res.status(404).json({ status: 'fail', message: `No training data found for grade '${req.params.gradeName}'` });
  }
  const elements = ['Fe', 'C', 'Si', 'Mn', 'P', 'S'];
  const bySampleType = {};
  rows.forEach((r) => { (bySampleType[r.sample_type] ||= []).push(r); });
  const statistics = Object.entries(bySampleType).map(([sampleType, group]) => {
    const stat = { _id: sampleType, count: group.length };
    elements.forEach((el) => {
      const values = group.map((r) => r[el]);
      stat[`avg${el}`] = values.reduce((a, b) => a + b, 0) / values.length;
      stat[`min${el}`] = Math.min(...values);
      stat[`max${el}`] = Math.max(...values);
    });
    return stat;
  });
  res.json({ status: 'success', data: { grade, statistics } });
});

trainingData.get('/grade/:gradeName', (req, res) => {
  const grade = req.params.gradeName.toUpperCase();
  const { sample_type, limit = 100 } = req.query;
  let data = store.getAll().filter((r) => r.grade === grade);
  if (sample_type) data = data.filter((r) => r.sample_type === sample_type);
  data = data.slice(0, parseInt(limit, 10));
  res.json({ status: 'success', results: data.length, data: { trainingData: data } });
});

trainingData.get('/', (req, res) => {
  const data = store.getAll();
  res.json({ status: 'success', results: data.length, data: { data } });
});

trainingData.post('/', requireAuth, requireRole('METALLURGIST', 'ADMIN'), (req, res) => {
  res.status(201).json({ status: 'success', data: { data: store.create(req.body) } });
});

trainingData.get('/:id', (req, res) => {
  const doc = store.findById(req.params.id);
  if (!doc) return res.status(404).json({ status: 'fail', message: 'No document found with that ID' });
  res.json({ status: 'success', data: { data: doc } });
});

trainingData.patch('/:id', requireAuth, requireRole('METALLURGIST', 'ADMIN'), (req, res) => {
  const doc = store.updateById(req.params.id, req.body);
  if (!doc) return res.status(404).json({ status: 'fail', message: 'No document found with that ID' });
  res.json({ status: 'success', data: { data: doc } });
});

trainingData.delete('/:id', requireAuth, requireRole('METALLURGIST', 'ADMIN'), (req, res) => {
  const ok = store.deleteById(req.params.id);
  if (!ok) return res.status(404).json({ status: 'fail', message: 'No document found with that ID' });
  res.status(204).json({ status: 'success', data: null });
});

app.use('/api/v2/training-data', trainingData);

// ======================= GRADES =======================
const grades = express.Router();

grades.get('/', (req, res) => {
  const specs = gradeStore.getAllSpecs();
  res.json({ status: 'success', results: specs.length, data: { data: specs } });
});

grades.post('/', requireAuth, requireRole('METALLURGIST', 'ADMIN'), (req, res) => {
  if (!req.body.grade) return res.status(400).json({ status: 'fail', message: 'grade is required' });
  res.status(201).json({ status: 'success', data: { data: gradeStore.create(req.body) } });
});

grades.get('/:gradeName/composition', (req, res) => {
  const spec = gradeStore.getByName(req.params.gradeName);
  if (!spec) return res.status(404).json({ status: 'fail', message: `Grade '${req.params.gradeName}' not found` });
  res.json({ status: 'success', data: { grade: spec.grade, composition_ranges: spec.composition_ranges } });
});

grades.get('/:gradeName', (req, res) => {
  const spec = gradeStore.getByName(req.params.gradeName);
  if (!spec) return res.status(404).json({ status: 'fail', message: `Grade '${req.params.gradeName}' not found` });
  res.json({ status: 'success', data: { grade: spec } });
});

grades.patch('/:id', requireAuth, requireRole('METALLURGIST', 'ADMIN'), (req, res) => {
  const spec = gradeStore.update(req.params.id, req.body);
  if (!spec) return res.status(404).json({ status: 'fail', message: 'No document found with that ID' });
  res.json({ status: 'success', data: { data: spec } });
});

grades.delete('/:id', requireAuth, requireRole('METALLURGIST', 'ADMIN'), (req, res) => {
  const ok = gradeStore.remove(req.params.id);
  if (!ok) return res.status(404).json({ status: 'fail', message: 'No document found with that ID' });
  res.status(204).json({ status: 'success', data: null });
});

app.use('/api/v2/grades', grades);

// ======================= OPC UA / SYNTHETIC =======================
// generateSyntheticReading helper (shared by both route sets below)
function generateReading(metalGrade, deviationElements = [], deviationPercentage = 10) {
  const spec = gradeStore.getByName(metalGrade);
  if (!spec) throw new Error(`Metal grade '${metalGrade}' not found in specifications`);

  const composition = {};
  const actualDeviationElements = [];
  Object.entries(spec.composition_ranges).forEach(([element, range]) => {
    const [min, max] = range;
    const midpoint = (min + max) / 2;
    const tolerance = (max - min) / 2;
    let value;
    if (deviationElements.includes(element)) {
      value = Math.max(0, min - (tolerance * deviationPercentage) / 100);
      actualDeviationElements.push(element);
    } else {
      value = midpoint + (Math.random() - 0.5) * tolerance * 0.8;
    }
    composition[element] = Math.round(value * 1000) / 1000;
  });

  return {
    metalGrade: metalGrade.toUpperCase(),
    metal_grade: metalGrade.toUpperCase(), // kept for any caller expecting snake_case
    composition,
    is_synthetic: true,
    deviation_applied: actualDeviationElements.length > 0,
    deviation_elements: actualDeviationElements,
  };
}

const opcRouter = express.Router();

opcRouter.get('/opc-status', (req, res) => {
  res.json({ status: 'success', data: opcuaService.getOPCStatus() });
});

opcRouter.post('/opc-connect', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), async (req, res) => {
  const result = await opcuaService.connectClient();
  res.status(result.success ? 200 : 500).json({
    status: result.success ? 'success' : 'error',
    message: result.message || result.error,
    data: result.status,
  });
});

opcRouter.post('/opc-disconnect', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), async (req, res) => {
  const result = await opcuaService.disconnectClient();
  res.status(result.success ? 200 : 500).json({
    status: result.success ? 'success' : 'error',
    message: result.message || result.error,
    data: result.status,
  });
});

opcRouter.post('/opc-reading', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), async (req, res) => {
  const { metalGrade, deviationElements = [], deviationPercentage = 10 } = req.body;
  if (!metalGrade) return res.status(400).json({ status: 'fail', message: 'Metal grade is required' });
  const result = await opcuaService.requestSpectrometerReading(metalGrade, deviationElements, deviationPercentage);
  res.status(result.success ? 200 : 500).json(result.success
    ? { status: 'success', data: { reading: result.data } }
    : { status: 'error', message: result.error });
});

opcRouter.post('/generate-synthetic', requireAuth, requireRole('METALLURGIST', 'ADMIN'), requireDevOrTest('Synthetic spectrometer data generation'), (req, res) => {
  const { metalGrade, deviationElements = [], deviationPercentage = 10 } = req.body;
  if (!metalGrade) return res.status(400).json({ status: 'fail', message: 'Metal grade is required' });
  try {
    const reading = generateReading(metalGrade, deviationElements, deviationPercentage);
    res.status(201).json({ status: 'success', data: { reading } });
  } catch (err) {
    res.status(400).json({ status: 'fail', message: err.message });
  }
});

// In-memory manual/generated readings log (CRUD used by spectrometerService.js)
const readings = [];
let nextReadingId = 1;

opcRouter.get('/', (req, res) => {
  res.json({ status: 'success', results: readings.length, data: { data: readings } });
});

opcRouter.post('/', requireAuth, requireRole('METALLURGIST', 'ADMIN'), requireDevOrTest('Manual synthetic reading persistence'), (req, res) => {
  const reading = { _id: String(nextReadingId++), ...req.body, createdAt: new Date() };
  readings.push(reading);
  res.status(201).json({ status: 'success', data: { data: reading } });
});

opcRouter.get('/:id', (req, res) => {
  const reading = readings.find((r) => r._id === req.params.id);
  if (!reading) return res.status(404).json({ status: 'fail', message: 'No document found with that ID' });
  res.json({ status: 'success', data: { data: reading } });
});

opcRouter.delete('/:id', requireAuth, requireRole('ADMIN'), requireDevOrTest('Manual synthetic reading deletion'), (req, res) => {
  const idx = readings.findIndex((r) => r._id === req.params.id);
  if (idx === -1) return res.status(404).json({ status: 'fail', message: 'No document found with that ID' });
  readings.splice(idx, 1);
  res.status(204).json({ status: 'success', data: null });
});

// Mount at every path shape the frontend actually calls:
// - opcService.js uses api.get('/synthetic/...') -> /api/v2/synthetic/...
app.use('/api/v2/synthetic', opcRouter);
// - spectrometerService.js uses api.get('/api/v1/spectrometer/...') where
//   `api` already has baseURL '/api/v2', producing '/api/v2/api/v1/spectrometer/...'
app.use('/api/v2/api/v1/spectrometer', opcRouter);
// - also expose the "correct" plain path in case anything calls it directly
app.use('/api/v1/spectrometer', opcRouter);

// ======================= AI SERVICE PROXY (:8000) =======================
const axios = require('axios');
const INTERNAL_SERVICE_KEY = process.env.METALLISENSE_INTERNAL_SERVICE_KEY || 'metallisense-internal-service-secret-key-2026';
axios.defaults.headers.common['X-Internal-Service-Key'] = INTERNAL_SERVICE_KEY;

const AI_URL = {
  toString() { return process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000'; }
};
const AGENT_URL = {
  toString() { return process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:8001'; }
};

async function proxy(res, method, url, data) {
  try {
    const response = await axios({
      method,
      url,
      data,
      headers: {
        'X-Internal-Service-Key': INTERNAL_SERVICE_KEY,
        'Authorization': `Bearer ${INTERNAL_SERVICE_KEY}`
      },
      timeout: 30000
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    if (err.response) {
      res.status(err.response.status).json(err.response.data);
    } else {
      res.status(503).json({
        status: 'error',
        message: `Could not reach ${url} — is that service running? (${err.message})`,
      });
    }
  }
}

const aiRouter = express.Router();

aiRouter.get('/health', (req, res) => proxy(res, 'get', `${AI_URL}/health`));
aiRouter.post('/anomaly/predict', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), (req, res) => proxy(res, 'post', `${AI_URL}/anomaly/predict`, req.body));
aiRouter.post('/individual/analyze', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), async (req, res) => {
  const { metalGrade, composition } = req.body;
  if (!metalGrade) return res.status(400).json({ status: 'fail', message: 'Metal grade is required' });
  if (!composition) return res.status(400).json({ status: 'fail', message: 'Composition data is required' });

  // The real AI service has no combined /individual/analyze endpoint — it
  // exposes /anomaly/predict and /alloy/recommend separately. Call both
  // and combine into the shape the frontend expects.
  let anomalyResult = null;
  let alloyResult = null;
  let serviceAvailable = true;
  const errors = [];

  try {
    const r = await axios.post(`${AI_URL}/anomaly/predict`, { composition, grade: metalGrade }, { timeout: 30000 });
    anomalyResult = r.data;
  } catch (err) {
    serviceAvailable = false;
    errors.push(err.response?.data?.detail || err.message);
  }

  try {
    const r = await axios.post(`${AI_URL}/alloy/recommend`, { composition, grade: metalGrade }, { timeout: 30000 });
    alloyResult = r.data;
  } catch (err) {
    serviceAvailable = false;
    errors.push(err.response?.data?.detail || err.message);
  }

  res.status(200).json({
    status: 'success',
    data: {
      metalGrade: metalGrade.toUpperCase(),
      composition,
      aiAnalysis: {
        mode: 'individual',
        anomalyDetection: anomalyResult,
        alloyRecommendation: alloyResult,
        serviceAvailable,
        ...(errors.length > 0 ? { errors, warning: 'AI service experienced errors. Results may be incomplete.' } : {}),
      },
      timestamp: new Date(),
    },
  });
});
aiRouter.post('/agent/analyze', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), async (req, res) => {
  const { metalGrade, composition } = req.body;
  if (!metalGrade) return res.status(400).json({ status: 'fail', message: 'Metal grade is required' });
  if (!composition) return res.status(400).json({ status: 'fail', message: 'Composition data is required' });

  // The real Agent service route is /agents/analyze (plural), and expects
  // { composition, grade } — not { metalGrade, composition }.
  try {
    const r = await axios.post(`${AGENT_URL}/agents/analyze`, { composition, grade: metalGrade }, { timeout: 30000 });
    res.status(200).json({
      status: 'success',
      data: {
        metalGrade: metalGrade.toUpperCase(),
        composition,
        aiAnalysis: {
          mode: 'agent',
          agentResponse: r.data,
          serviceAvailable: true,
        },
        timestamp: new Date(),
      },
    });
  } catch (err) {
    const detail = err.response?.data?.detail || err.message;
    res.status(200).json({
      status: 'success',
      data: {
        metalGrade: metalGrade.toUpperCase(),
        composition,
        aiAnalysis: {
          mode: 'agent',
          agentResponse: null,
          serviceAvailable: false,
          error: detail,
          warning: 'AI agent service unavailable. Using fallback response.',
        },
        timestamp: new Date(),
      },
    });
  }
});
aiRouter.post('/explain', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), async (req, res) => {
  // Frontend (AIAgent.jsx) sends { metalGrade, composition, anomalyResult,
  // alloyResult } — the Agent's /copilot/explain only requires
  // { composition, grade }. Translate field names + wrap the response in
  // the shape AIAgent.jsx expects: data.geminiExplanation.explanation.
  const { metalGrade, grade, composition } = req.body;
  const body = { composition, grade: grade || metalGrade };
  try {
    const response = await axios.post(`${AGENT_URL}/copilot/explain`, body, { timeout: 30000 });
    res.status(200).json({ status: 'success', data: { geminiExplanation: response.data } });
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    res.status(503).json({ status: 'error', message: `Could not reach ${AGENT_URL}/copilot/explain (${err.message})` });
  }
});
aiRouter.post('/analyze-with-explanation', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), (req, res) => proxy(res, 'post', `${AGENT_URL}/analyze-with-explanation`, req.body));
aiRouter.post('/what-if', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), (req, res) => proxy(res, 'post', `${AGENT_URL}/copilot/what-if`, req.body));
aiRouter.get('/gemini/health', (req, res) => proxy(res, 'get', `${AGENT_URL}/health`));

app.use('/api/v2/ai', aiRouter);

// ======================= CONNECTED FULL WORKFLOW =======================
// Chains: Anomaly Detection -> Alloy Recommendation -> RL Optimization ->
// Cost + Carbon + Trust annotation — all from ONE composition input, so
// the frontend doesn't need to copy data between separate pages.
app.post('/api/v2/workflow/full-analysis', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), async (req, res) => {
  const { metalGrade, composition, batchWeightKg, topK } = req.body;
  if (!metalGrade) return res.status(400).json({ status: 'fail', message: 'Metal grade is required' });
  if (!composition) return res.status(400).json({ status: 'fail', message: 'Composition data is required' });

  const weight = batchWeightKg ?? 1000;
  const result = {
    metalGrade: metalGrade.toUpperCase(),
    composition,
    batchWeightKg: weight,
    steps: {},
  };

  // Step 1 + 2: Anomaly Detection + Alloy Recommendation (combined agent call)
  try {
    const agentResp = await axios.post(
      `${AGENT_URL}/agents/analyze`,
      { composition, grade: metalGrade },
      { timeout: 30000 },
    );
    const anomaly = agentResp.data.anomaly_agent;
    const alloy = agentResp.data.alloy_agent;

    result.steps.anomalyDetection = anomaly
      ? { ...anomaly }
      : null;

    if (alloy) {
      result.steps.alloyRecommendation = {
        ...alloy,
        estimatedCost: computeCostEstimate({ grade: metalGrade, batchWeightKg: weight, recommendedAdditions: alloy.recommended_additions || {} }),
        estimatedCarbon: computeCarbonEstimate({ grade: metalGrade, batchWeightKg: weight, recommendedAdditions: alloy.recommended_additions || {} }),
      };
    } else {
      result.steps.alloyRecommendation = null;
    }
  } catch (err) {
    result.steps.anomalyDetection = null;
    result.steps.alloyRecommendation = null;
    result.steps.anomalyAlloyError = err.response?.data?.detail || err.message;
  }

  // Step 3: Closed-loop RL Optimization (independent candidates, same input)
  try {
    const rlResp = await axios.post(
      `${AGENT_URL}/rl/optimize`,
      { grade: metalGrade, composition, top_k: topK ?? 3 },
      { timeout: 30000 },
    );
    const rlData = rlResp.data;
    if (Array.isArray(rlData?.candidates)) {
      rlData.candidates = rlData.candidates.map((c) => {
        const cost = computeCostEstimate({ grade: metalGrade, batchWeightKg: weight, recommendedAdditions: c.recommended_additions || {}, strategy: c.strategy });
        return {
          ...c,
          estimatedCost: cost,
          estimatedCarbon: computeCarbonEstimate({ grade: metalGrade, batchWeightKg: weight, recommendedAdditions: c.recommended_additions || {} }),
          ...computeCandidateSavings(metalGrade, cost.totalAdditionsCost),
        };
      });
    }
    result.steps.rlOptimization = rlData;
  } catch (err) {
    result.steps.rlOptimization = null;
    result.steps.rlError = err.response?.data?.detail || err.message;
  }

  // Step 4: Root cause hypothesis for this grade (from historical CSV data)
  try {
    const rows = store.getAll().filter((r) => r.grade === metalGrade.toUpperCase());
    if (rows.length > 0) {
      const deviatedRows = rows.filter((r) => r.sample_type === 'deviated');
      const elements = ['Fe', 'C', 'Si', 'Mn', 'P', 'S'];
      const outlierCounts = {};
      elements.forEach((el) => {
        const values = rows.map((r) => r[el]);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
        outlierCounts[el] = deviatedRows.filter((r) => Math.abs(r[el] - mean) > 1.5 * std).length;
      });
      const top = Object.entries(outlierCounts).sort((a, b) => b[1] - a[1])[0];
      result.steps.rootCauseHint = top && top[1] > 0
        ? `Historically, ${top[0]} is the most frequent outlier in deviated ${metalGrade} batches — worth checking if that's a factor here too.`
        : null;
    }
  } catch (err) {
    result.steps.rootCauseHint = null;
  }

  // Automatic owner email — triggers for MEDIUM severity and above.
  // Best-effort: never blocks or fails the main analysis response if
  // email sending has an issue.
  result.steps.emailAlert = { sent: false, reason: 'Not triggered — severity below MEDIUM' };
  const anomalySeverity = result.steps.anomalyDetection?.severity;
  if (anomalySeverity && emailService.shouldTriggerEmail(anomalySeverity)) {
    try {
      const gradeUpper = metalGrade.toUpperCase();
      // Use the SAME numbers already shown on the Full Analysis page —
      // the "balanced" RL candidate — instead of recomputing a separate
      // figure from the base alloy recommendation, which previously
      // produced a different (and confusingly mismatched) number.
      const balancedCandidate = result.steps.rlOptimization?.candidates?.find(
        (c) => c.strategy === 'balanced'
      ) || result.steps.rlOptimization?.candidates?.[0];
      const alloyStep = result.steps.alloyRecommendation;

      let costDetails = null;
      if (balancedCandidate) {
        costDetails = {
          correctionCost: balancedCandidate.estimatedCost?.totalAdditionsCost ?? null,
          carbonKg: balancedCandidate.estimatedCarbon?.totalBatchCo2Kg ?? null,
          savingsPerTon: balancedCandidate.savingsPerTon ?? null,
          savingsPercent: balancedCandidate.savingsPercentOfSellingPrice ?? null,
          downgradeGrade: balancedCandidate.lossIfDowngraded?.downgradeGrade ?? null,
          lossPerTon: balancedCandidate.lossIfDowngraded?.lossPerTon ?? null,
        };
      }
      const emailResult = await emailService.sendDeviationAlertEmail({
        grade: gradeUpper,
        severity: anomalySeverity,
        composition,
        recommendedAdditions: balancedCandidate?.recommended_additions ?? alloyStep?.recommended_additions,
        costDetails,
      });
      result.steps.emailAlert = emailResult;
    } catch (err) {
      result.steps.emailAlert = { sent: false, reason: err.message };
    }
  }

  res.status(200).json({ status: 'success', data: result });
});

// ======================= RL SERVICE PROXY (:8001) =======================
const rlRouter = express.Router();
const rlFeedbackLog = []; // in-memory audit log, no DB

// ======================= COST INTELLIGENCE (shared helper) =======================
// Estimated ₹/kg of contained element x kg of that element added, summed —
// plus base metal cost for the whole batch. Used both by the standalone
// /api/v2/cost/estimate endpoint and to annotate RL candidates below.
// Deterministic operational/risk premium by strategy — reflects real-world
// costs beyond pure material price: conservative corrections need less
// handling/QA, aggressive corrections carry more overshoot/rework risk and
// need more verification. Per explicit instruction: conservative sits
// ₹1,000-5,000 BELOW balanced, aggressive sits ₹5,000-10,000 ABOVE balanced.
const STRATEGY_OPERATIONAL_PREMIUM = {
  conservative: 800,   // balanced(4300) - conservative(800) = 3500 (within 1000-5000)
  balanced: 4300,
  aggressive: 11300,   // aggressive(11300) - balanced(4300) = 7000 (within 5000-10000)
};

function computeCostEstimate({ grade, batchWeightKg, recommendedAdditions = {}, basePricePerKg, strategy }) {
  const baseRate = basePricePerKg ?? priceStore.getBasePriceForGrade(grade);
  const weight = Number(batchWeightKg) || 0;
  const baseMetalCost = Math.round(baseRate * weight * 100) / 100;

  const additionsCost = {};
  let materialCost = 0;
  const flags = [];

  Object.entries(recommendedAdditions).forEach(([element, kg]) => {
    const qty = Number(kg) || 0;
    const pricePerKg = priceStore.getElementPrice(element);
    const cost = Math.round(qty * pricePerKg * 100) / 100;
    additionsCost[element] = cost;
    materialCost += cost;
    if ((element === 'P' || element === 'S') && qty > 0) {
      flags.push(`${element} addition of ${qty}kg is unusual — P/S are normally minimized, not added deliberately. Verify this recommendation.`);
    }
  });

  const operationalPremium = STRATEGY_OPERATIONAL_PREMIUM[strategy] ?? 0;
  if (operationalPremium > 0) {
    additionsCost['_operationalPremium'] = operationalPremium;
  }

  const totalAdditionsCost = Math.round((materialCost + operationalPremium) * 100) / 100;
  const totalBatchCost = Math.round((baseMetalCost + totalAdditionsCost) * 100) / 100;
  const costPerKg = weight > 0 ? Math.round((totalBatchCost / weight) * 100) / 100 : null;

  return {
    grade: grade ? grade.toUpperCase() : null,
    batchWeightKg: weight,
    baseMetalPricePerKg: baseRate,
    baseMetalCost,
    materialCost: Math.round(materialCost * 100) / 100,
    operationalPremium,
    operationalPremiumNote: operationalPremium > 0
      ? 'Handling/QA/rework-risk premium that scales with correction aggressiveness — not raw material cost.'
      : null,
    additionsCost,
    totalAdditionsCost,
    totalBatchCost,
    costPerKg,
    currency: 'INR',
    flags,
    disclaimer: 'Prices are illustrative placeholder defaults, not live market data. Update via PATCH /api/v2/cost/prices.',
  };
}

// Per-candidate savings breakdown: how much this specific correction saves
// vs letting the batch downgrade to the next lower grade (or scrap).
function computeCandidateSavings(grade, correctionCostPerTon) {
  const downgradeInfo = sellingPriceStore.getDowngradeLossPerTon(grade);
  if (!downgradeInfo) return null;
  const savingsPerTon = downgradeInfo.lossPerTon - correctionCostPerTon;
  const savingsPercentOfSellingPrice = downgradeInfo.targetSellingPricePerTon > 0
    ? (savingsPerTon / downgradeInfo.targetSellingPricePerTon) * 100
    : 0;
  return {
    lossIfDowngraded: downgradeInfo, // { targetGrade, targetSellingPricePerTon, downgradeGrade, downgradeSellingPricePerTon, lossPerTon }
    savingsPerTon: Math.round(savingsPerTon * 100) / 100,
    savingsPercentOfSellingPrice: Math.round(savingsPercentOfSellingPrice * 10) / 10,
  };
}

const costHistory = []; // in-memory log of computed estimates, no DB

// Carbon footprint estimate — same shape/pattern as computeCostEstimate.
function computeCarbonEstimate({ grade, batchWeightKg, recommendedAdditions = {}, baseCo2PerKg }) {
  const baseRate = baseCo2PerKg ?? carbonStore.getBaseCarbonForGrade(grade);
  const weight = Number(batchWeightKg) || 0;
  const baseMetalCo2 = Math.round(baseRate * weight * 100) / 100;

  const additionsCo2 = {};
  let totalAdditionsCo2 = 0;

  Object.entries(recommendedAdditions).forEach(([element, kg]) => {
    const qty = Number(kg) || 0;
    const co2PerKg = carbonStore.getElementCo2(element);
    const co2 = Math.round(qty * co2PerKg * 100) / 100;
    additionsCo2[element] = co2;
    totalAdditionsCo2 += co2;
  });

  totalAdditionsCo2 = Math.round(totalAdditionsCo2 * 100) / 100;
  const totalBatchCo2Kg = Math.round((baseMetalCo2 + totalAdditionsCo2) * 100) / 100;
  const co2PerKgMetal = weight > 0 ? Math.round((totalBatchCo2Kg / weight) * 1000) / 1000 : null;

  return {
    grade: grade ? grade.toUpperCase() : null,
    batchWeightKg: weight,
    baseMetalCo2PerKg: baseRate,
    baseMetalCo2Kg: baseMetalCo2,
    additionsCo2Kg: additionsCo2,
    totalAdditionsCo2Kg: totalAdditionsCo2,
    totalBatchCo2Kg,
    co2PerKgMetal,
    unit: 'kg CO2e',
    disclaimer: 'Illustrative placeholder emission factors, not certified LCA data. Update via PATCH /api/v2/carbon/factors.',
  };
}

// Confidence-weighted trust score — combines the model's own confidence
// with how far the reading is from the grade's known-good composition
// range, so operators know when to double-check an AI suggestion rather
// than trust it blindly. Purely additive annotation, no model changes.
let nextCostId = 1;

rlRouter.post('/optimize', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), async (req, res) => {
  // Frontend sends topK (camelCase); the Agent service's Pydantic schema
  // requires top_k (snake_case). Convert before forwarding.
  const { grade, composition, topK, top_k, batchWeightKg } = req.body;
  const body = { grade, composition, top_k: top_k ?? topK ?? 3 };
  try {
    const response = await axios.post(`${AGENT_URL}/rl/optimize`, body, { timeout: 30000 });
    const agentData = response.data;

    // Annotate each candidate with an estimated cost, without touching
    // the RL logic itself — purely additive.
    const weight = batchWeightKg ?? 1000; // default 1 tonne batch if not given
    if (Array.isArray(agentData?.candidates)) {
      agentData.candidates = agentData.candidates.map((c) => {
        const cost = computeCostEstimate({
          grade,
          batchWeightKg: weight,
          recommendedAdditions: c.recommended_additions || {},
          strategy: c.strategy,
        });
        return {
          ...c,
          estimatedCost: cost,
          estimatedCarbon: computeCarbonEstimate({
            grade,
            batchWeightKg: weight,
            recommendedAdditions: c.recommended_additions || {},
          }),
          ...computeCandidateSavings(grade, cost.totalAdditionsCost),
        };
      });
    }

    // Frontend reads res.data.data — wrap the Agent's raw response.
    res.status(200).json({ status: 'success', data: agentData });
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    const { GRADE_SPECS } = require('./premeltGate/config');
    const targetSpec = (GRADE_SPECS && GRADE_SPECS[grade.toUpperCase()]) || { C: [3.0, 4.0], Si: [1.8, 2.8], Mn: [0.3, 1.0] };
    const comp = composition || {};
    
    // Balanced: target spec midpoint
    const balSi = Math.max(0, ((targetSpec.Si[0] + targetSpec.Si[1]) / 2) - (comp.Si || 0));
    const balMn = Math.max(0, ((targetSpec.Mn[0] + targetSpec.Mn[1]) / 2) - (comp.Mn || 0));
    const balFeSiKg = Math.round(((balSi / 100) * weight / (0.75 * 0.85)) * 10) / 10;
    const balFeMnKg = Math.round(((balMn / 100) * weight / (0.70 * 0.85)) * 10) / 10;

    // Conservative: target lower quartile
    const conSi = Math.max(0, (targetSpec.Si[0] + 0.1) - (comp.Si || 0));
    const conMn = Math.max(0, (targetSpec.Mn[0] + 0.05) - (comp.Mn || 0));
    const conFeSiKg = Math.round(((conSi / 100) * weight / (0.75 * 0.85)) * 10) / 10;
    const conFeMnKg = Math.round(((conMn / 100) * weight / (0.70 * 0.85)) * 10) / 10;

    const rawCandidates = [
      {
        strategy: 'balanced',
        aggressiveness: 0.5,
        predicted_reward: 0.85,
        recommended_additions: {
          'FeSi-75': balFeSiKg > 0 ? balFeSiKg : 5,
          'HC FeMn': balFeMnKg > 0 ? balFeMnKg : 2.5
        }
      },
      {
        strategy: 'conservative',
        aggressiveness: 0.2,
        predicted_reward: 0.72,
        recommended_additions: {
          'FeSi-75': conFeSiKg > 0 ? conFeSiKg : 2.5,
          'HC FeMn': conFeMnKg > 0 ? conFeMnKg : 1.2
        }
      }
    ];

    const candidates = rawCandidates.map((c) => {
      const cost = computeCostEstimate({
        grade,
        batchWeightKg: weight,
        recommendedAdditions: c.recommended_additions || {},
        strategy: c.strategy,
      });
      return {
        ...c,
        estimatedCost: cost,
        estimatedCarbon: computeCarbonEstimate({
          grade,
          batchWeightKg: weight,
          recommendedAdditions: c.recommended_additions || {},
        }),
        ...computeCandidateSavings(grade, cost.totalAdditionsCost),
      };
    });

    res.status(200).json({
      status: 'success',
      data: {
        candidates,
        isFallback: true,
        advisoryOnly: true,
        modelStatus: 'OFFLINE',
        method: 'DETERMINISTIC_MASS_BALANCE',
        notice: 'Advisory candidate additions computed via deterministic mass balance. Agent offline.'
      }
    });
  }
});

rlRouter.post('/feedback', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), async (req, res) => {
  const { grade, composition, additions, aggressiveness, outcome, actualResult, actual_result, operatorNote, operator_note } = req.body;
  const body = {
    grade,
    composition,
    additions,
    aggressiveness: aggressiveness ?? 1.0,
    outcome,
    actual_result: actual_result ?? actualResult ?? null,
    operator_note: operator_note ?? operatorNote ?? null,
  };
  try {
    const response = await axios.post(`${AGENT_URL}/rl/feedback`, body, { timeout: 3000 });
    rlFeedbackLog.unshift({ ...body, computedReward: response.data?.computed_reward ?? null, createdAt: new Date() });
    res.status(response.status).json(response.data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    rlFeedbackLog.unshift({ ...body, computedReward: null, agentOffline: true, createdAt: new Date() });
    res.status(200).json({
      status: 'success',
      recorded: true,
      agentOffline: true,
      computed_reward: null,
      message: 'Feedback logged locally (agent sidecar offline)'
    });
  }
});

rlRouter.get('/policy/status', async (req, res) => {
  try {
    const response = await axios.get(`${AGENT_URL}/rl/policy/status`, { timeout: 3000 });
    res.status(200).json({ status: 'success', data: response.data });
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    res.status(200).json({
      status: 'offline',
      online: false,
      message: 'RL Agent sidecar is offline (advisory mode)',
      data: null
    });
  }
});

rlRouter.get('/feedback', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json({ status: 'success', results: Math.min(limit, rlFeedbackLog.length), data: rlFeedbackLog.slice(0, limit) });
});

app.use('/api/v2/rl', rlRouter);

// ======================= VECTOR SEARCH PROXY (Actian VectorAI DB) =======================
const vectorRouter = express.Router();
vectorRouter.get('/status', (req, res) => proxy(res, 'get', `${AGENT_URL}/vector/status`));
vectorRouter.post('/reindex', requireAuth, requireRole('ADMIN'), (req, res) => proxy(res, 'post', `${AGENT_URL}/vector/reindex`, {}));
vectorRouter.post('/search', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), (req, res) => proxy(res, 'post', `${AGENT_URL}/vector/search`, req.body));
vectorRouter.post('/memory/add', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), (req, res) => proxy(res, 'post', `${AGENT_URL}/vector/memory/add`, req.body));
vectorRouter.post('/memory/recall', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), (req, res) => proxy(res, 'post', `${AGENT_URL}/vector/memory/recall`, req.body));
app.use('/api/v2/vector', vectorRouter);

// ======================= COST INTELLIGENCE =======================
const costRouter = express.Router();

costRouter.get('/prices', (req, res) => {
  res.json({
    status: 'success',
    data: {
      elementPrices: priceStore.getElementPrices(),
      baseMetalPrices: priceStore.getBaseMetalPrices(),
      currency: 'INR',
      disclaimer: 'Illustrative placeholder defaults, not live market data.',
    },
  });
});

costRouter.patch('/prices', requireAuth, requireRole('SALES_FINANCE', 'ADMIN'), (req, res) => {
  const { elementPrices, baseMetalPrices } = req.body;
  if (!elementPrices && !baseMetalPrices) {
    return res.status(400).json({ status: 'fail', message: 'Provide elementPrices and/or baseMetalPrices to update' });
  }
  if (elementPrices) priceStore.updateElementPrices(elementPrices);
  if (baseMetalPrices) priceStore.updateBaseMetalPrices(baseMetalPrices);
  res.json({
    status: 'success',
    data: {
      elementPrices: priceStore.getElementPrices(),
      baseMetalPrices: priceStore.getBaseMetalPrices(),
    },
  });
});

costRouter.post('/estimate', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'SALES_FINANCE', 'ADMIN'), (req, res) => {
  const { grade, batchWeightKg, recommendedAdditions, basePricePerKg } = req.body;
  if (!grade) return res.status(400).json({ status: 'fail', message: 'grade is required' });
  if (!batchWeightKg) return res.status(400).json({ status: 'fail', message: 'batchWeightKg is required' });

  const estimate = computeCostEstimate({ grade, batchWeightKg, recommendedAdditions: recommendedAdditions || {}, basePricePerKg });

  const entry = { _id: String(nextCostId++), ...estimate, createdAt: new Date() };
  costHistory.unshift(entry);
  if (costHistory.length > 500) costHistory.length = 500; // cap the in-memory log

  res.status(200).json({ status: 'success', data: estimate });
});

costRouter.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const grade = req.query.grade ? req.query.grade.toUpperCase() : null;
  let entries = costHistory;
  if (grade) entries = entries.filter((e) => e.grade === grade);
  res.json({ status: 'success', results: Math.min(limit, entries.length), data: entries.slice(0, limit) });
});

app.use('/api/v2/cost', costRouter);

// ======================= CARBON INTELLIGENCE =======================
const carbonRouter = express.Router();
const carbonHistory = [];
let nextCarbonId = 1;

carbonRouter.get('/factors', (req, res) => {
  res.json({
    status: 'success',
    data: {
      elementCarbon: carbonStore.getElementCarbon(),
      baseMetalCarbon: carbonStore.getBaseMetalCarbon(),
      unit: 'kg CO2e',
      disclaimer: 'Illustrative placeholder emission factors, not certified LCA data.',
    },
  });
});

carbonRouter.patch('/factors', requireAuth, requireRole('METALLURGIST', 'ADMIN'), (req, res) => {
  const { elementCarbon, baseMetalCarbon } = req.body;
  if (!elementCarbon && !baseMetalCarbon) {
    return res.status(400).json({ status: 'fail', message: 'Provide elementCarbon and/or baseMetalCarbon to update' });
  }
  if (elementCarbon) carbonStore.updateElementCarbon(elementCarbon);
  if (baseMetalCarbon) carbonStore.updateBaseMetalCarbon(baseMetalCarbon);
  res.json({
    status: 'success',
    data: {
      elementCarbon: carbonStore.getElementCarbon(),
      baseMetalCarbon: carbonStore.getBaseMetalCarbon(),
    },
  });
});

carbonRouter.post('/estimate', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'SALES_FINANCE', 'ADMIN'), (req, res) => {
  const { grade, batchWeightKg, recommendedAdditions, baseCo2PerKg } = req.body;
  if (!grade) return res.status(400).json({ status: 'fail', message: 'grade is required' });
  if (!batchWeightKg) return res.status(400).json({ status: 'fail', message: 'batchWeightKg is required' });

  const estimate = computeCarbonEstimate({ grade, batchWeightKg, recommendedAdditions: recommendedAdditions || {}, baseCo2PerKg });

  const entry = { _id: String(nextCarbonId++), ...estimate, createdAt: new Date() };
  carbonHistory.unshift(entry);
  if (carbonHistory.length > 500) carbonHistory.length = 500;

  res.status(200).json({ status: 'success', data: estimate });
});

carbonRouter.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const grade = req.query.grade ? req.query.grade.toUpperCase() : null;
  let entries = carbonHistory;
  if (grade) entries = entries.filter((e) => e.grade === grade);
  res.json({ status: 'success', results: Math.min(limit, entries.length), data: entries.slice(0, limit) });
});

app.use('/api/v2/carbon', carbonRouter);

// ======================= ALERT / ESCALATION SIMULATION =======================
// Simulates what a shift-supervisor alert would look like for severe
// deviations, closing the "AI -> human escalation" story without needing
// real SMS/email integration. Purely a drafted message, never actually sent.
const alertLog = [];
let nextAlertId = 1;

app.post('/api/v2/alerts/simulate', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), requireDevOrTest('Alert simulation'), (req, res) => {
  const { grade, severity, deviationElements = [], batchId, operatorName } = req.body;
  if (!grade || !severity) {
    return res.status(400).json({ status: 'fail', message: 'grade and severity are required' });
  }

  const isUrgent = ['severe', 'HIGH'].includes(severity);
  const subject = isUrgent
    ? `🚨 URGENT: Severe deviation detected — ${grade}${batchId ? ` (Batch ${batchId})` : ''}`
    : `⚠️ Deviation flagged — ${grade}${batchId ? ` (Batch ${batchId})` : ''}`;

  const body = [
    `Grade: ${grade}`,
    batchId ? `Batch: ${batchId}` : null,
    `Severity: ${severity}`,
    deviationElements.length > 0 ? `Affected elements: ${deviationElements.join(', ')}` : null,
    operatorName ? `Flagged by: ${operatorName}` : null,
    '',
    isUrgent
      ? 'Immediate review recommended before proceeding with this batch. See MetalliSense for AI-suggested corrections.'
      : 'Review when convenient. AI-suggested corrections are available in MetalliSense.',
  ].filter(Boolean).join('\n');

  const alert = {
    _id: String(nextAlertId++),
    channel: isUrgent ? 'sms+email (simulated)' : 'email (simulated)',
    subject,
    body,
    recipientRole: isUrgent ? 'Shift Supervisor + Plant Manager' : 'Shift Supervisor',
    sent: false, // never actually sent — this is a simulation/demo only
    createdAt: new Date(),
  };
  alertLog.unshift(alert);
  if (alertLog.length > 200) alertLog.length = 200;

  res.status(201).json({ status: 'success', data: alert, note: 'Simulated only — no real message was sent.' });
});

app.get('/api/v2/alerts/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json({ status: 'success', results: Math.min(limit, alertLog.length), data: alertLog.slice(0, limit) });
});

// ======================= ROOT CAUSE HYPOTHESIS =======================
// Simple, explainable rule-based correlation over the CSV training data —
// not a black-box model. Looks for patterns like "this element deviates
// more often for this grade" using only data already loaded in memory.
app.get('/api/v2/rootcause/:gradeName', (req, res) => {
  const grade = req.params.gradeName.toUpperCase();
  const rows = store.getAll().filter((r) => r.grade === grade);
  if (rows.length === 0) {
    return res.status(404).json({ status: 'fail', message: `No training data found for grade '${req.params.gradeName}'` });
  }

  const deviatedRows = rows.filter((r) => r.sample_type === 'deviated');
  const deviationRate = rows.length > 0 ? deviatedRows.length / rows.length : 0;

  const elements = ['Fe', 'C', 'Si', 'Mn', 'P', 'S'];
  const elementOutlierCounts = {};
  elements.forEach((el) => {
    const values = rows.map((r) => r[el]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    elementOutlierCounts[el] = deviatedRows.filter((r) => Math.abs(r[el] - mean) > 1.5 * std).length;
  });

  const rankedElements = Object.entries(elementOutlierCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([element, count]) => ({
      element,
      outlierCount: count,
      shareOfDeviations: deviatedRows.length > 0 ? Math.round((count / deviatedRows.length) * 1000) / 10 : 0,
    }));

  const topElement = rankedElements[0];
  const hypothesis = topElement && topElement.outlierCount > 0
    ? `${topElement.element} is the most frequent outlier in deviated ${grade} batches — appearing unusually far from the mean in ${topElement.shareOfDeviations}% of deviated samples. Worth checking ${topElement.element}-related feedstock consistency or furnace conditions for this grade.`
    : `No single element stands out as a dominant outlier for deviated ${grade} batches in the available data — deviations appear spread across multiple elements or are due to factors not captured in composition data alone (e.g. temperature, timing).`;

  res.json({
    status: 'success',
    data: {
      grade,
      totalSamples: rows.length,
      deviatedSamples: deviatedRows.length,
      deviationRatePercent: Math.round(deviationRate * 1000) / 10,
      rankedElements,
      hypothesis,
      methodology: 'Rule-based statistical outlier analysis (>1.5 std dev from grade mean) over historical CSV data — not a black-box model, fully explainable.',
    },
  });
});

// ======================= COST SAVINGS ANALYSIS =======================
// Estimates the real ₹ value of catching and correcting deviated batches
// with MetalliSense, vs letting them go to rejection/downgrade — computed
// purely from the historical CSV data and researched real element prices,
// no external AI service call needed. Fully re-runnable once a new/real
// dataset replaces dataset.csv.
function computeSavingsForGrade(grade, rejectionLossFraction, useSellingPriceModel) {
  const rows = store.getAll().filter((r) => r.grade === grade);
  if (rows.length === 0) return null;

  const normalRows = rows.filter((r) => r.sample_type === 'normal');
  const deviatedRows = rows.filter((r) => r.sample_type === 'deviated');
  const elements = ['Fe', 'C', 'Si', 'Mn', 'P', 'S'];

  // IMPORTANT: don't use gradeSpecStore's derived composition_ranges here —
  // those are computed as literally the min/max of ALL rows (including
  // deviated ones), so nothing could ever fall outside them (self-referential,
  // always zero deviations detected). Instead, define the "normal" target
  // range from NON-deviated rows only: mean ± 1 std dev of the population
  // the dataset itself already labels as in-spec. This is an independent,
  // defensible reference — not circular.
  const normalStats = {};
  elements.forEach((el) => {
    const values = normalRows.map((r) => r[el]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    normalStats[el] = { mean, std, low: mean - std, high: mean + std };
  });

  // Per-batch weight assumption: 1000kg (1 tonne) — composition % on a
  // 1000kg batch maps directly to kg (e.g. 3.5% Si shortfall = 3.5kg Si).
  const BATCH_KG = 1000;
  const baseMetalCostPerTon = priceStore.getBasePriceForGrade(grade) * BATCH_KG;

  let correctableCount = 0;
  let totalCorrectionCost = 0;
  const elementShortfallCost = {};
  elements.forEach((el) => { elementShortfallCost[el] = 0; });

  let aboveMaxCount = 0; // tracked separately — not cost-modeled (needs dilution/rework, not a simple addition)

  deviatedRows.forEach((row) => {
    let rowCost = 0;
    let hasCorrectableShortfall = false;
    elements.forEach((el) => {
      const { low, high } = normalStats[el];
      const value = row[el];
      if (value < low) {
        const shortfallKg = (low - value) * (BATCH_KG / 100); // % -> kg on batch basis
        const cost = shortfallKg * priceStore.getElementPrice(el);
        rowCost += cost;
        elementShortfallCost[el] += cost;
        hasCorrectableShortfall = true;
      } else if (value > high) {
        aboveMaxCount += 1;
      }
    });
    if (hasCorrectableShortfall) {
      correctableCount += 1;
      totalCorrectionCost += rowCost;
    }
  });

  const avgCorrectionCostPerTon = correctableCount > 0 ? totalCorrectionCost / correctableCount : 0;

  // Two ways to model what's "lost" if the batch is NOT corrected:
  //   1. Real downgrade model: batch gets sold as the next lower grade
  //      (or scrap) — loss = target selling price − downgrade selling price.
  //   2. Fallback: an assumed fraction of base metal cost is lost.
  let lossPerTon;
  let lossModel;
  const downgradeInfo = sellingPriceStore.getDowngradeLossPerTon(grade);

  if (useSellingPriceModel && downgradeInfo) {
    lossPerTon = downgradeInfo.lossPerTon;
    lossModel = { type: 'selling-price-downgrade', ...downgradeInfo };
  } else {
    lossPerTon = baseMetalCostPerTon * rejectionLossFraction;
    lossModel = { type: 'assumed-fraction', rejectionLossFraction, baseMetalCostPerTon };
  }

  const savingsPerTon = lossPerTon - avgCorrectionCostPerTon;
  // Savings % = savings ÷ the CORRECT grade's selling price (not ÷ the
  // at-risk loss amount) — i.e. what fraction of the batch's actual sale
  // value is preserved by correcting it instead of letting it downgrade.
  const targetSellingPricePerTon = sellingPriceStore.getSellingPrice(grade);
  const savingsPercentBase = useSellingPriceModel && targetSellingPricePerTon
    ? targetSellingPricePerTon
    : baseMetalCostPerTon;
  const savingsPercent = savingsPercentBase > 0 ? (savingsPerTon / savingsPercentBase) * 100 : 0;
  const correctionAsPercentOfBaseCost = baseMetalCostPerTon > 0 ? (avgCorrectionCostPerTon / baseMetalCostPerTon) * 100 : 0;

  return {
    grade,
    totalSamples: rows.length,
    deviatedSamples: deviatedRows.length,
    deviationRatePercent: Math.round((deviatedRows.length / rows.length) * 1000) / 10,
    correctableDeviations: correctableCount,
    aboveMaxDeviations: aboveMaxCount,
    baseMetalCostPerTon: Math.round(baseMetalCostPerTon * 100) / 100,
    avgCorrectionCostPerTon: Math.round(avgCorrectionCostPerTon * 100) / 100,
    correctionCostByElement: Object.fromEntries(
      Object.entries(elementShortfallCost)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, Math.round((v / correctableCount) * 100) / 100]),
    ),
    lossModel,
    lossPerTon: Math.round(lossPerTon * 100) / 100,
    savingsPerTon: Math.round(savingsPerTon * 100) / 100,
    savingsPercentOfSellingPrice: Math.round(savingsPercent * 10) / 10,
    correctionCostAsPercentOfBaseCost: Math.round(correctionAsPercentOfBaseCost * 100) / 100,
    currency: 'INR',
  };
}

app.get('/api/v2/cost/savings-analysis', (req, res) => {
  const rejectionLossFraction = req.query.rejectionLossFraction
    ? parseFloat(req.query.rejectionLossFraction)
    : 0.35; // fallback only, used if useSellingPriceModel=false or no downgrade price is set for a grade
  const useSellingPriceModel = req.query.lossModel !== 'fraction'; // default: real selling-price downgrade model

  const grades = req.query.grade
    ? [req.query.grade.toUpperCase()]
    : [...new Set(store.getAll().map((r) => r.grade))];

  const perGrade = grades
    .map((g) => computeSavingsForGrade(g, rejectionLossFraction, useSellingPriceModel))
    .filter(Boolean);

  const totalDeviated = perGrade.reduce((sum, g) => sum + g.deviatedSamples, 0);
  const totalCorrectable = perGrade.reduce((sum, g) => sum + g.correctableDeviations, 0);
  const weightedSavingsPerTon = totalCorrectable > 0
    ? perGrade.reduce((sum, g) => sum + g.savingsPerTon * g.correctableDeviations, 0) / totalCorrectable
    : 0;
  const weightedSavingsPercent = perGrade.length > 0
    ? perGrade.reduce((sum, g) => sum + g.savingsPercentOfSellingPrice * g.correctableDeviations, 0) / (totalCorrectable || 1)
    : 0;

  res.json({
    status: 'success',
    data: {
      overall: {
        gradesAnalyzed: perGrade.length,
        totalDeviatedSamples: totalDeviated,
        totalCorrectableSamples: totalCorrectable,
        avgSavingsPerTon: Math.round(weightedSavingsPerTon * 100) / 100,
        avgSavingsPercentOfSellingPrice: Math.round(weightedSavingsPercent * 10) / 10,
        currency: 'INR',
      },
      byGrade: perGrade,
      methodology: [
        'Target range per element = mean ± 1 std dev of that grade\'s NON-deviated ("normal") samples in the dataset — an independent reference, not circular with the deviated samples being measured.',
        'Correction cost = sum of (target-low − actual value) × real element price, for elements below that target range — mirrors what an alloy-recommendation model would actually correct.',
        'Elements ABOVE the target range are counted but not cost-modeled here (removing excess needs dilution/rework, a different and more complex cost problem — flagged separately as "aboveMaxDeviations").',
        useSellingPriceModel
          ? 'Loss if uncorrected = (target grade selling price − downgraded grade selling price) per ton, i.e. what the batch actually sells for once downgraded to the next lower grade (or scrap, if none). See GET /api/v2/cost/selling-prices for the price ladder and its sourcing/confidence per grade. Pass ?lossModel=fraction to use the older flat-percentage assumption instead.'
          : `Loss if uncorrected = assumed flat ${Math.round(rejectionLossFraction * 100)}% of base metal cost (older fallback model — pass no lossModel param, or lossModel=selling-price, to use real grade-downgrade pricing instead).`,
        'Batch size assumed at 1000kg (1 tonne) for this report.',
        'Based on the CURRENT dataset.csv (200,000 synthetic-style rows). Re-run this same endpoint once a real production dataset replaces it — no code changes needed.',
      ],
    },
  });
});

app.get('/api/v2/cost/selling-prices', (req, res) => {
  res.json({ status: 'success', data: sellingPriceStore.getSellingPrices() });
});

app.patch('/api/v2/cost/selling-prices', requireAuth, requireRole('SALES_FINANCE', 'ADMIN'), (req, res) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ status: 'fail', message: 'Provide { "GRADE": pricePerTon, ... } to update' });
  }
  const updated = sellingPriceStore.updateSellingPrices(req.body);
  res.json({ status: 'success', data: updated });
});


// ======================= RAW MATERIAL STOCK + PRE-MELT GATE =======================
// Raw material & alloy additive stock, sponge iron (DRI) QA lab entry,
// handheld XRF/LIBS gun simulator (OPC UA, port 4335) and the Pre-Melt Gate
// that locks "Start melting" until the charge passes. See premeltGate/README.md.
const premelt = require('./premeltGate/routes');
app.use('/api/v2/premelt', premelt.router);
// Supplier Scorecard + Energy per Heat (added module)
app.use('/api/v2/insights', require('./premeltGate/insightsRoutes'));
// Inventory Forecasting & Reorder (added module)
app.use('/api/v2/inventory', require('./premeltGate/inventoryRoutes'));
// Sales & Dispatch: finish heat on tap approval, invoice + test certificate (added module)
app.use('/api/v2/sales', require('./premeltGate/salesRoutes'));

// Mechanical Property Prediction
app.use('/api/v2/mechanical', mechanicalRoutes);
premelt.gunService.initializeServerOnly().then((ok) => {
  console.log(ok ? '✅ Handheld gun OPC UA simulator ready (opc.tcp://localhost:4335/MetalliSense/HandheldGun)' : '❌ Handheld gun OPC UA simulator failed to start');
});

app.use((req, res) => {
  res.status(404).json({ status: 'fail', message: `Can't find ${req.originalUrl} on this server!` });
});

// Auto-retry on the next port if the requested one is already in use,
// instead of crashing outright — handles the case where something else
// (or a duplicate launch) is already bound to the requested port.
function startServer(startPort, attemptsLeft = 10) {
  const server = app.listen(startPort, () => {
    console.log(`MetalliSense Simple Backend running on port ${startPort} (no login, no database — CSV only)`);
    if (startPort !== port) {
      console.log(`NOTE: Port ${port} was already in use, so this server is running on ${startPort} instead.`);
      console.log(`Update your frontend's VITE_API_BASE_URL to http://localhost:${startPort}/api/v2 if needed.`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${startPort} is already in use — trying port ${startPort + 1} instead...`);
      startServer(startPort + 1, attemptsLeft - 1);
    } else {
      console.error('Failed to start server:', err.message);
      process.exit(1);
    }
  });
  return server;
}

if (require.main === module) {
  startServer(port);
}

module.exports = { app, startServer };