import { createContext, useContext, useState, useEffect } from "react";
import api from "../services/api";

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Check current session on mount
  useEffect(() => {
    let mounted = true;
    api.get("/auth/me")
      .then((res) => {
        if (mounted && res.data?.data?.user) {
          setUser(res.data.data.user);
        }
      })
      .catch(() => {
        if (mounted) setUser(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  const login = async (username, password) => {
    const res = await api.post("/auth/login", { username, password });
    if (res.data?.data?.user) {
      setUser(res.data.data.user);
      return res.data.data.user;
    }
    return null;
  };

  const logout = async () => {
    try {
      await api.post("/auth/logout");
    } catch (_) {}
    setUser(null);
  };

  const value = {
    user,
    mongoUser: user,
    loading,
    login,
    logout,
    signup: async () => user,
    updateUserProfile: async () => user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
