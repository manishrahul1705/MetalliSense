import { createContext, useContext, useState, useEffect } from "react";
import api from "../services/api";

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Restore a real session; optional loopback-only development auto-login.
  useEffect(() => {
    let mounted = true;
    api.get("/auth/me")
      .then((res) => {
        if (import.meta.env.DEV && res.data?.data?.user?.userId === 'LOCAL-DEV-ADMIN') return api.post("/auth/local-session");
        return res;
      })
      .catch(async (error) => {
        if (import.meta.env.DEV && error.response?.status === 401) return api.post("/auth/local-session");
        throw error;
      })
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
    } catch (_) { /* Clear local session even if the server is unavailable. */ }
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
