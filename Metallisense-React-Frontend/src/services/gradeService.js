import api from "./api";

// Get all grades
export const getAllGrades = (params) => api.get("/grades", { params });

// Create new grade
export const createGrade = (data) => api.post("/grades", data);

// Get grade by name
export const getGradeByName = (gradeName) => api.get(`/grades/${gradeName}`);

// Get grade composition
export const getGradeComposition = (gradeName) =>
  api.get(`/grades/${gradeName}/composition`);

// Update grade
export const updateGrade = (id, data) => api.patch(`/grades/${id}`, data);

// Delete grade
export const deleteGrade = (id) => api.delete(`/grades/${id}`);
