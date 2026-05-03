import React, { useState } from "react";
import Card from "../components/common/Card";
import Badge from "../components/common/Badge";
import SyntheticGenerator from "../components/common/SyntheticGenerator";
import toast from "react-hot-toast";
import { formatPercentage } from "../utils/formatters";

const SyntheticData = () => {
  const [generatedReading, setGeneratedReading] = useState(null);

  const handleDataGenerated = async (reading, params) => {
    setGeneratedReading(reading);
    toast.success("Synthetic reading generated successfully");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-dark-900">
          Synthetic Data Generator
        </h1>
        <p className="text-dark-600 mt-1">
          Generate synthetic spectrometer readings for testing and training
        </p>
      </div>

      {/* Synthetic Generator */}
      <SyntheticGenerator
        onDataGenerated={handleDataGenerated}
        buttonText="Generate Synthetic Reading"
      />

      {/* Display Generated Reading */}
      {generatedReading && (
        <Card title="Generated Reading">
          <div className="space-y-4">
            {/* Metadata */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pb-4 border-b border-dark-200">
              <div>
                <p className="text-sm text-dark-600">Metal Grade</p>
                <p className="text-lg font-bold font-mono text-dark-900">
                  {generatedReading.metalGrade}
                </p>
              </div>
              <div>
                <p className="text-sm text-dark-600">Deviation %</p>
                <p className="text-lg font-bold text-primary-600">
                  {generatedReading.deviationPercentage}%
                </p>
              </div>
              <div>
                <p className="text-sm text-dark-600">Temperature</p>
                <p className="text-lg font-bold text-dark-900">
                  {generatedReading.temperature}°C
                </p>
              </div>
              <div>
                <p className="text-sm text-dark-600">Pressure</p>
                <p className="text-lg font-bold text-dark-900">
                  {generatedReading.pressure} atm
                </p>
              </div>
            </div>

            {/* Composition */}
            <div>
              <h3 className="text-lg font-semibold text-dark-900 mb-3">
                Composition
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {Object.entries(generatedReading.composition).map(
                  ([element, value]) => {
                    const isDeviated =
                      generatedReading.deviationElements?.includes(element);
                    return (
                      <div
                        key={element}
                        className={`p-4 rounded-lg border-2 ${
                          isDeviated
                            ? "bg-yellow-50 border-yellow-300"
                            : "bg-dark-50 border-dark-200"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-mono font-bold text-lg text-dark-900">
                            {element}
                          </span>
                          {isDeviated && (
                            <Badge variant="warning" className="text-xs">
                              Deviated
                            </Badge>
                          )}
                        </div>
                        <p className="text-2xl font-bold text-dark-900">
                          {formatPercentage(value)}
                        </p>
                      </div>
                    );
                  }
                )}
              </div>
            </div>

            {/* Applied Deviations */}
            {generatedReading.appliedDeviations &&
              generatedReading.appliedDeviations.length > 0 && (
                <div className="pt-4 border-t border-dark-200">
                  <h3 className="text-lg font-semibold text-dark-900 mb-3">
                    Applied Deviations
                  </h3>
                  <div className="grid gap-3">
                    {generatedReading.appliedDeviations.map(
                      (deviation, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-3 bg-yellow-50 border border-yellow-200 rounded-lg"
                        >
                          <div className="flex items-center gap-3">
                            <Badge variant="warning" className="font-mono">
                              {deviation.element}
                            </Badge>
                            <span className="text-dark-700">
                              {formatPercentage(deviation.original)} →{" "}
                              {formatPercentage(deviation.deviated)}
                            </span>
                          </div>
                          <Badge variant="warning">
                            {deviation.deviationPercent > 0 ? "+" : ""}
                            {deviation.deviationPercent.toFixed(2)}%
                          </Badge>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

            {/* Additional Info */}
            <div className="pt-4 border-t border-dark-200">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-dark-600">Source</p>
                  <p className="font-semibold text-dark-900">
                    {generatedReading.source || "synthetic"}
                  </p>
                </div>
                <div>
                  <p className="text-dark-600">Base Sample ID</p>
                  <p className="font-mono text-xs text-dark-900">
                    {generatedReading.baseSampleId
                      ? generatedReading.baseSampleId.slice(-12)
                      : "N/A"}
                  </p>
                </div>
                <div>
                  <p className="text-dark-600">Timestamp</p>
                  <p className="text-dark-900">
                    {generatedReading.timestamp
                      ? new Date(generatedReading.timestamp).toLocaleString()
                      : new Date().toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default SyntheticData;
