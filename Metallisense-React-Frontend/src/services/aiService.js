import api from "./api";

// AI Health Check
export const checkAIHealth = () => api.get("/ai/health");

// Anomaly Detection - Direct endpoint
export const predictAnomaly = async (data) => {
  console.log("🔍 Anomaly Predict Request:", data);
  const response = await api.post("/ai/anomaly/predict", data);
  console.log("✅ Anomaly Predict Response:", response.data);
  return response;
};

// Individual Analysis (Anomaly + Alloy)
export const analyzeIndividual = (data) =>
  api.post("/ai/individual/analyze", data);

// AI Agent Analysis
export const analyzeAgent = (data) => api.post("/ai/agent/analyze", data);

// AI Explanation Services (Google Gemini Integration)
// Analyze reading with AI-powered explanation
export const analyzeWithExplanation = (data) =>
  api.post("/ai/analyze-with-explanation", data);

// Get AI explanation for specific results
export const explainResult = (data) => api.post("/ai/explain", data);

// Run what-if scenario analysis
export const whatIfAnalysis = (data) => api.post("/ai/what-if", data);
