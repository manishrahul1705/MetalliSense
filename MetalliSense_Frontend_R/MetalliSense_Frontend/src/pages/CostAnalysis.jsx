import React, { useEffect, useState } from "react";
import { IndianRupee, Save, RefreshCw } from "lucide-react";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import Input from "../components/common/Input";
import { getPrices, updatePrices, getCostHistory } from "../services/costService";
import toast from "react-hot-toast";

// Cost Intelligence — price editor + recent batch cost estimates.
// Fully additive: doesn't touch anomaly/RL/OPC logic, just visualizes and
// edits the price list used to annotate RL candidates with ₹ estimates.
export default function CostAnalysis() {
  const [elementPrices, setElementPrices] = useState({});
  const [baseMetalPrices, setBaseMetalPrices] = useState({});
  const [editedElements, setEditedElements] = useState({});
  const [editedGrades, setEditedGrades] = useState({});
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [pricesRes, historyRes] = await Promise.all([
        getPrices(),
        getCostHistory(20),
      ]);
      setElementPrices(pricesRes.data.data.elementPrices);
      setBaseMetalPrices(pricesRes.data.data.baseMetalPrices);
      setHistory(historyRes.data.data);
    } catch (error) {
      console.error("Failed to load cost data:", error);
      toast.error("Could not load cost data — is the backend running?");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleSave = async () => {
    if (Object.keys(editedElements).length === 0 && Object.keys(editedGrades).length === 0) {
      toast("No changes to save");
      return;
    }
    setSaving(true);
    try {
      await updatePrices({
        elementPrices: editedElements,
        baseMetalPrices: editedGrades,
      });
      toast.success("Prices updated");
      setEditedElements({});
      setEditedGrades({});
      loadAll();
    } catch (error) {
      console.error("Failed to update prices:", error);
      toast.error("Failed to update prices");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <Card>
          <p className="text-center text-metal-500 py-12">Loading cost data…</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <IndianRupee className="text-emerald-600" size={28} />
          <div>
            <h1 className="text-2xl font-bold text-metal-900">Cost Analysis</h1>
            <p className="text-metal-500 text-sm">
              Alloy &amp; base metal pricing — annotates Adaptive Strategy Optimizer recommendations with ₹ estimates
            </p>
          </div>
        </div>
        <Button variant="secondary" onClick={loadAll}>
          <RefreshCw size={16} className="mr-2" /> Refresh
        </Button>
      </div>

      <Card>
        <p className="text-xs text-amber-600 mb-4">
          Current market rate of the raw materials</p>

        <h2 className="font-semibold text-metal-800 mb-3">Element Prices (₹ per kg, contained element)</h2>
        <div className="grid sm:grid-cols-2 gap-3 mb-6">
          {Object.entries(elementPrices).map(([el, info]) => (
            <div key={el} className="flex items-center gap-3">
              <span className="w-10 font-mono font-bold">{el}</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                defaultValue={info.pricePerKg}
                containerClassName="mb-0 flex-1"
                onChange={(e) =>
                  setEditedElements((prev) => ({ ...prev, [el]: parseFloat(e.target.value) || 0 }))
                }
              />
              <span className="text-xs text-metal-500 w-40 truncate" title={info.via}>{info.via}</span>
            </div>
          ))}
        </div>

        <h2 className="font-semibold text-metal-800 mb-3">Base Metal Cost by Grade (₹ per kg)</h2>
        <div className="grid sm:grid-cols-2 gap-3 mb-6">
          {Object.entries(baseMetalPrices).map(([grade, price]) => (
            <div key={grade} className="flex items-center gap-3">
              <span className="w-40 text-sm">{grade}</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                defaultValue={price}
                containerClassName="mb-0 flex-1"
                onChange={(e) =>
                  setEditedGrades((prev) => ({ ...prev, [grade]: parseFloat(e.target.value) || 0 }))
                }
              />
            </div>
          ))}
        </div>

        <Button onClick={handleSave} loading={saving}>
          <Save size={16} className="mr-2" /> Save Prices
        </Button>
      </Card>

      <Card>
        <h2 className="font-semibold text-metal-800 mb-3">Recent Cost Estimates</h2>
        {history.length === 0 ? (
          <p className="text-metal-500 text-sm py-6 text-center">
            No cost estimates yet — run the Adaptive Strategy Optimizer or use the Cost API to generate some.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-metal-500 border-b">
                  <th className="py-2 pr-4">Grade</th>
                  <th className="py-2 pr-4">Batch (kg)</th>
                  <th className="py-2 pr-4">Base Cost</th>
                  <th className="py-2 pr-4">Additions</th>
                  <th className="py-2 pr-4">Total</th>
                  <th className="py-2 pr-4">₹/kg</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h._id} className="border-b border-metal-100">
                    <td className="py-2 pr-4 font-medium">{h.grade}</td>
                    <td className="py-2 pr-4">{h.batchWeightKg?.toLocaleString("en-IN")}</td>
                    <td className="py-2 pr-4">₹{h.baseMetalCost?.toLocaleString("en-IN")}</td>
                    <td className="py-2 pr-4">₹{h.totalAdditionsCost?.toLocaleString("en-IN")}</td>
                    <td className="py-2 pr-4 font-semibold">₹{h.totalBatchCost?.toLocaleString("en-IN")}</td>
                    <td className="py-2 pr-4">₹{h.costPerKg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
