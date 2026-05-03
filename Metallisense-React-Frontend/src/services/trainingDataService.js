import api from "./api";

// Get paginated training data (primary endpoint)
export const getPaginatedTrainingData = (params) =>
  api.get("/training-data/paginated", { params });

// Get all training data
export const getAllTrainingData = (params) =>
  api.get("/training-data", { params });

// Get training data by grade
export const getTrainingDataByGrade = (gradeName, params) =>
  api.get(`/training-data/grade/${gradeName}`, { params });

// Get statistics for grade
export const getGradeStatistics = (gradeName) =>
  api.get(`/training-data/grade/${gradeName}/statistics`);

// Create training data
export const createTrainingData = (data) => api.post("/training-data", data);

// Update training data
export const updateTrainingData = (id, data) =>
  api.patch(`/training-data/${id}`, data);

// Delete training data
export const deleteTrainingData = (id) => api.delete(`/training-data/${id}`);

// Get visualization data (pre-aggregated)
export const getTrainingDataVisualizations = (params) =>
  api.get("/training-data/visualizations", { params });
