import api from "./api";

// Get OPC status (v1)
export const getSpectrometerOPCStatus = () =>
  api.get("/api/v1/spectrometer/opc-status");

// Connect OPC
export const connectSpectrometerOPC = () =>
  api.post("/api/v1/spectrometer/opc-connect");

// Disconnect OPC
export const disconnectSpectrometerOPC = () =>
  api.post("/api/v1/spectrometer/opc-disconnect");

// Request OPC reading
export const requestOPCReading = () =>
  api.post("/api/v1/spectrometer/opc-reading");

// Get all readings
export const getAllReadings = (params) =>
  api.get("/api/v1/spectrometer", { params });

// Create reading manually
export const createReading = (data) => api.post("/api/v1/spectrometer", data);

// Get specific reading
export const getReading = (id) => api.get(`/api/v1/spectrometer/${id}`);

// Delete reading
export const deleteReading = (id) => api.delete(`/api/v1/spectrometer/${id}`);
