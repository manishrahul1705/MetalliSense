import React, { createContext, useState, useEffect } from "react";
import { getAllGrades } from "../services/gradeService";

export const GradeContext = createContext();

export const GradeProvider = ({ children }) => {
  const [grades, setGrades] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchGrades = async (params = {}) => {
    setLoading(true);
    setError(null);
    try {
      const response = await getAllGrades(params);
      const data = response.data.data;
      // Ensure grades is always an array
      if (Array.isArray(data)) {
        setGrades(data);
      } else if (data && Array.isArray(data.data)) {
        setGrades(data.data);
      } else {
        console.warn("API returned non-array data:", data);
        setGrades([]);
      }
      return response.data;
    } catch (err) {
      const errorMsg = err.response?.data?.message || "Failed to fetch grades";
      setError(errorMsg);
      console.error("Failed to fetch grades:", err);
      setGrades([]);
      return { error: errorMsg };
    } finally {
      setLoading(false);
    }
  };

  const refreshGrades = () => {
    fetchGrades();
  };

  useEffect(() => {
    fetchGrades();
  }, []);

  return (
    <GradeContext.Provider
      value={{ grades, loading, error, fetchGrades, refreshGrades }}
    >
      {children}
    </GradeContext.Provider>
  );
};
