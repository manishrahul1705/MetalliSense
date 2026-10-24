import api from "./api";

// Raw material stock, alloy additives, DRI QA, handheld gun (XRF/LIBS)
// and the Pre-Melt Gate — backend routes under /api/v2/premelt.
const P = "/premelt";

// Stock
export const getStockSummary = () => api.get(`${P}/summary`);
export const getLots = (params = {}) => api.get(`${P}/lots`, { params });
export const getLot = (lotId) => api.get(`${P}/lots/${lotId}`);
export const receiveLot = (data) => api.post(`${P}/lots`, data);
export const setLotStatus = (lotId, data) => api.patch(`${P}/lots/${lotId}/status`, data);
export const adjustStock = (lotId, data) => api.post(`${P}/lots/${lotId}/adjust`, data);
export const getMovements = (lotId) => api.get(`${P}/movements`, { params: { lotId } });
export const getAdditives = () => api.get(`${P}/additives`);

// DRI lab (QA engineer)
export const enterDriQa = (lotId, data) => api.post(`${P}/lots/${lotId}/dri-qa`, data);
export const approveDriQa = (qaId, approver) => api.post(`${P}/dri-qa/${qaId}/approve`, { approver });
export const rejectDriQa = (qaId, approver, reason) => api.post(`${P}/dri-qa/${qaId}/reject`, { approver, reason });

// Handheld gun (OPC UA simulator)
export const getGunStatus = () => api.get(`${P}/gun/status`);
export const connectGun = () => api.post(`${P}/gun/connect`);
export const disconnectGun = () => api.post(`${P}/gun/disconnect`);
export const startInspection = (data) => api.post(`${P}/gun/inspect`, data);
export const getGunLive = () => api.get(`${P}/gun/live`);
export const replaceArgon = () => api.post(`${P}/gun/argon/replace`);
export const getScenarios = () => api.get(`${P}/gun/scenarios`);
export const getGunSessions = (lotId) => api.get(`${P}/gun/sessions`, { params: { lotId } });
export const ingestGunCsv = (csv, inspector) => api.post(`${P}/gun/ingest-csv`, { csv, inspector });
export const gunCsvUrl = (sessionId) => `${api.defaults.baseURL}${P}/gun/sessions/${sessionId}/csv`;

// Heats + gate
export const getHeats = () => api.get(`${P}/heats`);
export const getHeat = (heatId) => api.get(`${P}/heats/${heatId}`);
export const planHeat = (data) => api.post(`${P}/heats`, data);
export const updateCharge = (heatId, data) => api.put(`${P}/heats/${heatId}/charge`, data);
export const runGateCheck = (heatId, optionsOrBy) => {
  const payload = typeof optionsOrBy === 'string' ? { by: optionsOrBy } : (optionsOrBy || {});
  return api.post(`${P}/heats/${heatId}/gate-check`, payload);
};
export const startMelting = (heatId, data = {}) => api.post(`${P}/heats/${heatId}/start-melting`, data);

export const getPremeltConfig = () => api.get(`${P}/config`);

// Additive-specific endpoints
export const deductAdditives = (lines, options = {}) => {
  const key = typeof options === 'string'
    ? options
    : (options?.idempotencyKey || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `deduct-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`));
  const headers = { 'Idempotency-Key': key };
  return api.post(`${P}/additives/deduct`, { lines }, { headers });
};
export const receiveFerroalloy = (data) => api.post(`${P}/additives/receive`, data);
export const getAudit = (limit = 50) => api.get(`${P}/audit`, { params: { limit } });
export const resetDemo = () => api.post(`${P}/demo/reset`);
