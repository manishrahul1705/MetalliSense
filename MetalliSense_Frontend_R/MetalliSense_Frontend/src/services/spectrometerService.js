import api from "./api";

// Get OPC status (v1)
export const getSpectrometerOPCStatus = () =>
  api.get("/spectrometer/opc-status");

// Connect OPC
export const connectSpectrometerOPC = () =>
  api.post("/spectrometer/opc-connect");

// Disconnect OPC
export const disconnectSpectrometerOPC = () =>
  api.post("/spectrometer/opc-disconnect");

// Request OPC reading
export const requestOPCReading = (data) =>
  api.post("/spectrometer/opc-reading", data);

// Get all readings
export const getAllReadings = (params) =>
  api.get("/spectrometer", { params });

// Create reading manually
export const createReading = (data) => api.post("/spectrometer", data);

// Get specific reading
export const getReading = (id) => api.get(`/spectrometer/${id}`);

// Delete reading
export const deleteReading = (id) => api.delete(`/spectrometer/${id}`);
