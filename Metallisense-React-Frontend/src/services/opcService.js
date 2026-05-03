import api from "./api";

// OPC Status
export const getOPCStatus = () => api.get("/synthetic/opc-status");

// OPC Connect
export const connectOPC = () => api.post("/synthetic/opc-connect");

// OPC Disconnect
export const disconnectOPC = () => api.post("/synthetic/opc-disconnect");

// Generate Synthetic Reading
export const generateSyntheticReading = (data) =>
  api.post("/synthetic/generate-synthetic", data);
