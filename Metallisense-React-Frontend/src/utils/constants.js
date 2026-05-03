// Common element symbols for metal composition
export const ELEMENT_SYMBOLS = [
  "Fe",
  "C",
  "Mn",
  "Si",
  "P",
  "S",
  "Cr",
  "Ni",
  "Mo",
  "Cu",
  "Al",
  "V",
  "Ti",
  "Nb",
  "N",
];

// API endpoints
export const API_ENDPOINTS = {
  AI: {
    HEALTH: "/api/v2/ai/health",
    INDIVIDUAL_ANALYZE: "/api/v2/ai/individual/analyze",
    AGENT_ANALYZE: "/api/v2/ai/agent/analyze",
  },
  GRADES: "/api/v2/grades",
  TRAINING_DATA: "/api/v2/training-data",
  SYNTHETIC: {
    OPC_STATUS: "/api/v2/synthetic/opc-status",
    OPC_CONNECT: "/api/v2/synthetic/opc-connect",
    OPC_DISCONNECT: "/api/v2/synthetic/opc-disconnect",
    GENERATE: "/api/v2/synthetic/generate-synthetic",
  },
  SPECTROMETER: "/api/v1/spectrometer",
};

// OPC Connection polling interval (milliseconds)
export const OPC_POLL_INTERVAL = 3000;

// Table pagination
export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

// Status colors
export const STATUS_COLORS = {
  success: "text-green-600 bg-green-50 border-green-200",
  warning: "text-yellow-600 bg-yellow-50 border-yellow-200",
  error: "text-red-600 bg-red-50 border-red-200",
  info: "text-blue-600 bg-blue-50 border-blue-200",
};

// Anomaly thresholds
export const ANOMALY_THRESHOLDS = {
  HIGH: 0.7,
  MEDIUM: 0.4,
  LOW: 0.2,
};

// Deviation percentage limits
export const DEVIATION_LIMITS = {
  MIN: 0,
  MAX: 20,
  DEFAULT: 5,
};
