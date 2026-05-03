import api from "./api";

// Get all grade specifications
export const getAllGradeSpecs = () => api.get("/grades");

// Get single grade specification by ID
export const getGradeSpecById = (id) => api.get(`/grades/${id}`);

// Get grade specification by name
export const getGradeSpecByName = (gradeName) =>
  api.get(`/grades/${gradeName}`);

// Get composition ranges only
export const getGradeCompositionRanges = (gradeName) =>
  api.get(`/grades/${gradeName}/composition`);

// Create new grade specification
export const createGradeSpec = (data) => api.post("/grades", data);

// Update grade specification
export const updateGradeSpec = (id, data) => api.patch(`/grades/${id}`, data);

// Delete grade specification
export const deleteGradeSpec = (id) => api.delete(`/grades/${id}`);
