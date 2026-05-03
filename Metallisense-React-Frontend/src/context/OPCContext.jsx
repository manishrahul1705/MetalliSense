import React, { createContext, useState, useEffect, useContext } from "react";
import {
  getOPCStatus,
  connectOPC,
  disconnectOPC,
} from "../services/opcService";
import { OPC_POLL_INTERVAL } from "../utils/constants";

export const OPCContext = createContext();

export const OPCProvider = ({ children }) => {
  const [opcStatus, setOpcStatus] = useState({
    connected: false,
    serverUrl: null,
    lastUpdate: null,
    lastSeen: null,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await getOPCStatus();
        const data = response.data.data || response.data;

        // Parse the actual backend response structure
        const opcStatus = data.opcStatus || data;
        const clientStatus = opcStatus.client || {};
        const serverStatus = opcStatus.server || {};

        setOpcStatus({
          connected: clientStatus.isConnected || false,
          serverUrl: clientStatus.endpointUrl || serverStatus.endpoint || null,
          lastSeen: data.timestamp || null,
          lastUpdate: new Date(),
          status: clientStatus.status || "Disconnected",
          cachedData: clientStatus.cachedData || null,
        });
      } catch (error) {
        console.error("Failed to fetch OPC status:", error);
        setOpcStatus((prev) => ({
          ...prev,
          connected: false,
          lastUpdate: new Date(),
        }));
      }
    };

    // Poll every 3 seconds (no initial check to avoid auto-connect)
    const interval = setInterval(checkStatus, OPC_POLL_INTERVAL);

    return () => clearInterval(interval);
  }, []);

  const connect = async () => {
    setLoading(true);
    try {
      const response = await connectOPC();
      const data = response.data.data || response.data;

      // Parse the actual backend response structure
      const opcStatus = data.opcStatus || data;
      const clientStatus = opcStatus.client || {};
      const serverStatus = opcStatus.server || {};

      // Update status immediately with response
      setOpcStatus({
        connected: clientStatus.isConnected || true,
        serverUrl: clientStatus.endpointUrl || serverStatus.endpoint || null,
        lastSeen: data.timestamp || new Date().toISOString(),
        lastUpdate: new Date(),
        status: clientStatus.status || "Connected",
        cachedData: clientStatus.cachedData || null,
      });

      return { success: true };
    } catch (error) {
      console.error("Failed to connect OPC:", error);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    } finally {
      setLoading(false);
    }
  };

  const disconnect = async () => {
    setLoading(true);
    try {
      const response = await disconnectOPC();

      // Update status immediately
      setOpcStatus({
        connected: false,
        serverUrl: null,
        lastSeen: null,
        lastUpdate: new Date(),
      });

      return { success: true };
    } catch (error) {
      console.error("Failed to disconnect OPC:", error);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    } finally {
      setLoading(false);
    }
  };

  return (
    <OPCContext.Provider value={{ opcStatus, connect, disconnect, loading }}>
      {children}
    </OPCContext.Provider>
  );
};

// Custom hook to use OPC context
export const useOPC = () => {
  const context = useContext(OPCContext);
  if (!context) {
    throw new Error("useOPC must be used within an OPCProvider");
  }
  // Return with 'status' instead of 'opcStatus' for cleaner API
  return {
    status: context.opcStatus,
    connect: context.connect,
    disconnect: context.disconnect,
    loading: context.loading,
    connecting: context.loading,
  };
};
