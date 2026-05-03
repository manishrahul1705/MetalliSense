import React, { useState, useEffect, useContext } from "react";
import { OPCContext } from "../context/OPCContext";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import Table from "../components/common/Table";
import {
  connectSpectrometerOPC,
  disconnectSpectrometerOPC,
  requestOPCReading,
  getAllReadings,
  deleteReading,
} from "../services/spectrometerService";
import toast from "react-hot-toast";
import { formatDate, formatPercentage } from "../utils/formatters";
import { Trash2 } from "lucide-react";

const Spectrometer = () => {
  const { opcStatus } = useContext(OPCContext);
  const [readings, setReadings] = useState([]);
  const [latestReading, setLatestReading] = useState(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    fetchReadings();
  }, []);

  const fetchReadings = async () => {
    setLoading(true);
    try {
      const response = await getAllReadings();
      console.log("Spectrometer readings response:", response.data);
      const data = Array.isArray(response.data.data) ? response.data.data : [];
      console.log("Extracted readings:", data);
      setReadings(data);
      if (data.length > 0) {
        setLatestReading(data[0]);
      }
    } catch (error) {
      console.error("Failed to fetch readings:", error);
      toast.error("Failed to load readings");
    } finally {
      setLoading(false);
    }
  };

  const handleRequestReading = async () => {
    setRequesting(true);
    try {
      const response = await requestOPCReading();
      toast.success("OPC reading received");
      fetchReadings();
    } catch (error) {
      toast.error(
        error.response?.data?.message || "Failed to request OPC reading"
      );
    } finally {
      setRequesting(false);
    }
  };

  const handleDeleteReading = async (id) => {
    if (!window.confirm("Are you sure you want to delete this reading?"))
      return;

    try {
      await deleteReading(id);
      toast.success("Reading deleted successfully");
      fetchReadings();
    } catch (error) {
      toast.error("Failed to delete reading");
    }
  };

  const columns = [
    {
      header: "Timestamp",
      render: (row) => (
        <span className="font-mono text-sm">
          {formatDate(row.timestamp || row.createdAt)}
        </span>
      ),
    },
    {
      header: "Fe %",
      render: (row) => (
        <span className="font-mono">
          {formatPercentage(row.Fe || row.composition?.Fe || 0)}
        </span>
      ),
    },
    {
      header: "C %",
      render: (row) => (
        <span className="font-mono">
          {formatPercentage(row.C || row.composition?.C || 0)}
        </span>
      ),
    },
    {
      header: "Mn %",
      render: (row) => (
        <span className="font-mono">
          {formatPercentage(row.Mn || row.composition?.Mn || 0)}
        </span>
      ),
    },
    {
      header: "Si %",
      render: (row) => (
        <span className="font-mono">
          {formatPercentage(row.Si || row.composition?.Si || 0)}
        </span>
      ),
    },
    {
      header: "Actions",
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => handleDeleteReading(row._id)}
        >
          <Trash2 size={16} className="text-red-600" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Control Panel */}
      <Card title="OPC Control Panel">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`h-3 w-3 rounded-full ${
                opcStatus.connected
                  ? "bg-green-500 animate-pulse"
                  : "bg-red-500"
              }`}
            />
            <span className="font-medium">
              Status: {opcStatus.connected ? "Connected" : "Disconnected"}
            </span>
          </div>
          <Button
            onClick={handleRequestReading}
            loading={requesting}
            disabled={!opcStatus.connected}
          >
            Request Reading
          </Button>
        </div>
      </Card>

      {/* Latest Reading */}
      {latestReading && (
        <Card title="Latest Reading">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
            {Object.entries(latestReading.composition || latestReading)
              .filter(
                ([key]) =>
                  !key.startsWith("_") &&
                  key !== "timestamp" &&
                  key !== "createdAt"
              )
              .map(([element, value]) => (
                <div key={element} className="p-4 bg-dark-50 rounded-lg">
                  <span className="font-mono font-bold text-sm text-dark-600">
                    {element}
                  </span>
                  <p className="text-xl font-bold text-dark-900 mt-1">
                    {formatPercentage(value)}
                  </p>
                </div>
              ))}
          </div>
          <p className="text-xs text-dark-500 mt-4">
            Received:{" "}
            {formatDate(latestReading.timestamp || latestReading.createdAt)}
          </p>
        </Card>
      )}

      {/* Reading History */}
      <Card title="Reading History">
        <Table columns={columns} data={readings} loading={loading} />
      </Card>
    </div>
  );
};

export default Spectrometer;
