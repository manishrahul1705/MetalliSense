import { useState } from "react";
import { Wifi, WifiOff, Loader } from "lucide-react";
import { useOPC } from "../../context/OPCContext";
import Button from "../common/Button";
import toast from "react-hot-toast";

const OPCStatusIndicator = () => {
  const { status, connect, disconnect, connecting } = useOPC();
  const [actionLoading, setActionLoading] = useState(false);

  const handleConnect = async () => {
    setActionLoading(true);
    try {
      const result = await connect();
      if (result.success) {
        toast.success("OPC connection initiated");
      } else {
        toast.error(result.error || "Failed to connect to OPC");
      }
    } catch (error) {
      toast.error("Failed to connect to OPC");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setActionLoading(true);
    try {
      const result = await disconnect();
      if (result.success) {
        toast.success("OPC disconnected successfully");
      } else {
        toast.error(result.error || "Failed to disconnect from OPC");
      }
    } catch (error) {
      toast.error("Failed to disconnect from OPC");
    } finally {
      setActionLoading(false);
    }
  };

  const isLoading = actionLoading || connecting;

  return (
    <div
      data-tour="opc-status"
      className="flex items-center gap-3 bg-white/90 backdrop-blur-sm px-5 py-2.5 rounded-xl border-2 border-metal-200 shadow-metal"
    >
      {/* Status Indicator */}
      <div className="flex items-center gap-2">
        <div className="relative">
          <div
            className={`h-3 w-3 rounded-full ${
              status.connected ? "bg-primary-500" : "bg-metal-400"
            }`}
          />
          {status.connected && (
            <div className="absolute inset-0 h-3 w-3 rounded-full bg-primary-500 animate-ping opacity-75" />
          )}
        </div>
        <span className="text-sm font-semibold text-metal-800">
          {status.connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* Divider */}
      <div className="h-6 w-px bg-metal-300" />

      
        <div className="flex gap-2">
          {!status.connected ? (
            <Button
          variant="success"
          size="sm"
          onClick={handleConnect}
          disabled={isLoading}
          loading={isLoading}
          className="!py-1.5 !px-4 flex items-center gap-2"
            >
          <Wifi className="w-4 h-4" />
          <span>Connect</span>
            </Button>
          ) : (
            <Button
          variant="danger"
          size="sm"
          onClick={handleDisconnect}
          disabled={isLoading}
          loading={isLoading}
          className="!py-1.5 !px-4 flex items-center gap-2"
            >
          <WifiOff className="w-4 h-4" />
          <span>Disconnect</span>
            </Button>
          )}
        </div>

       
        
        {/* Connection Animation Visualization */}
      {status.connected && (
        <>
          <div className="h-6 w-px bg-metal-300" />
          <div className="flex items-center gap-2">
       
        {/* Flowing Data Particles */}
        <div className="flex gap-1">
          {[...Array(3)].map((_, i) => (
            <div
          key={i}
          className="w-1 h-3 bg-primary-500 rounded-full animate-bounce"
          style={{
            animationDelay: `${i * 0.2}s`,
            animationDuration: '1s'
          }}
            />
          ))}
        </div>
        
        <span className="text-xs font-medium text-primary-600">
          Live Data
        </span>
          </div>
        </>
      )}
    </div>
  );
};

export default OPCStatusIndicator;
