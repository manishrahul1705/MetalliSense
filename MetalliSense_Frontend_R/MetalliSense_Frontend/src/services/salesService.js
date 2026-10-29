import api from "./api";

// Sales & Dispatch — backend routes under /api/v2/sales.
const P = "/sales";

export const completeHeat = (heatId, data = {}) => {
  const { resume, ...payload } = data;
  return api.post(`${P}/heats/${heatId}/complete`, payload);
};
export const getFinishedHeats = () => api.get(`${P}/heats`);
export const getCertificate = (heatId) => api.get(`${P}/certificates/${heatId}`);
export const getCustomers = () => api.get(`${P}/customers`);
export const getInvoices = () => api.get(`${P}/invoices`);
export const getInvoice = (id) => api.get(`${P}/invoices/${encodeURIComponent(id)}`);
export const createInvoice = (data) => api.post(`${P}/invoices`, data);
export const getSalesConfig = () => api.get(`${P}/config`);
export const updateSalesConfig = (patch) => api.patch(`${P}/config`, patch);
