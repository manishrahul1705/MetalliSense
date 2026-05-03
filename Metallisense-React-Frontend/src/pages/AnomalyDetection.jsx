import { useState, useRef } from "react";
import { AlertTriangle, CheckCircle, Sparkles, Volume2, VolumeX, Loader2, MessageCircle } from "lucide-react";
import Card from "../components/common/Card";
import Badge from "../components/common/Badge";
import Button from "../components/common/Button";
import Table from "../components/common/Table";
import SyntheticGenerator from "../components/common/SyntheticGenerator";
import ExplanationCard from "../components/common/ExplanationCard";
import AIChatInterface from "../components/common/AIChatInterface";
import { predictAnomaly } from "../services/aiService";
import { getExplanation } from "../services/copilotService";
import toast from "react-hot-toast";
import { formatPercentage } from "../utils/formatters";

const AnomalyDetection = () => {
  const [generatedReading, setGeneratedReading] = useState(null);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiExplanation, setAiExplanation] = useState(null);
  const [loadingExplanation, setLoadingExplanation] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copilotExplanation, setCopilotExplanation] = useState(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const audioRef = useRef(null);

  const handleSyntheticDataGenerated = async (reading, params) => {
    setGeneratedReading(reading);
    setAiExplanation(null);
    setCopilotExplanation(null);
    setAudioUrl(null);
    setIsPlaying(false);

    // Automatically analyze the generated reading
    await performAnalysis(reading);
  };

  const performAnalysis = async (reading) => {
    setAnalyzing(true);
    setCopilotExplanation(null);
    try {
      const response = await predictAnomaly({
        grade: reading.metalGrade,
        composition: reading.composition,
      });

      if (response.data) {
        const result = response.data.data || response.data;
        setAnalysisResult(result);

        // Auto-generate copilot explanation after successful analysis
        await generateCopilotExplanation(reading, result);

        const severity = result.severity || "NORMAL";
        const anomalyStatus =
          severity === "HIGH" || severity === "MEDIUM"
            ? `Anomaly Detected (${severity})`
            : "No Anomaly";
        toast.success(`Analysis complete: ${anomalyStatus}`);
      }
    } catch (error) {
      console.error("Analysis failed:", error);
      toast.error(
        error.response?.data?.message || "Failed to analyze composition"
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const generateCopilotExplanation = async (reading, result) => {
    try {
      const response = await getExplanation({
        composition: reading.composition,
        grade: reading.metalGrade,
        analysisResult: result,
      });

      if (response.data) {
        setCopilotExplanation(response.data);
      }
    } catch (error) {
      console.error("Failed to get copilot explanation:", error);
      // Don't show error toast for copilot, it's supplementary
    }
  };

  const handleGetAIExplanation = async () => {
    if (!analysisResult || !generatedReading) {
      toast.error("No analysis results to explain");
      return;
    }

    await generateCopilotExplanation(generatedReading, analysisResult);
  };

  const handlePlayAudio = () => {
    if (!audioUrl) return;

    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        audioRef.current.play();
        setIsPlaying(true);
      }
    } else {
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      
      audio.onended = () => {
        setIsPlaying(false);
      };
      
      audio.onerror = () => {
        toast.error("Failed to play audio");
        setIsPlaying(false);
      };
      
      audio.play();
      setIsPlaying(true);
    }
  };

  const getComplianceColor = (compliance) => {
    if (compliance >= 90) return "text-green-600";
    if (compliance >= 70) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-dark-900">Anomaly Detection</h1>
        <p className="text-dark-600 mt-1">
          Generate synthetic readings and detect composition anomalies
        </p>
      </div>

      {/* Synthetic Generator */}
      <SyntheticGenerator
        onDataGenerated={handleSyntheticDataGenerated}
        buttonText="Generate & Analyze"
      />

      {/* Analysis Loading */}
      {analyzing && (
        <Card>
          <div className="flex items-center gap-3">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
            <span className="text-dark-700">
              Analyzing composition for anomalies...
            </span>
          </div>
        </Card>
      )}

      {/* Generated Reading & Analysis Results */}
      {generatedReading && (
        <>
          {/* Generated Reading Card */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-dark-900">
                Generated Reading
              </h3>
              <Badge variant="info">{generatedReading.metalGrade}</Badge>
            </div>

            <div className="space-y-4">
              {/* Composition */}
              <div>
                <p className="text-sm font-medium text-dark-700 mb-2">
                  Composition
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                  {Object.entries(generatedReading.composition || {}).map(
                    ([element, value]) => {
                      const isDeviated =
                        generatedReading.deviationElements?.includes(element);
                      return (
                        <div
                          key={element}
                          className={`p-3 rounded-lg border-2 ${
                            isDeviated
                              ? "border-yellow-400 bg-yellow-50"
                              : "border-dark-200 bg-dark-50"
                          }`}
                        >
                          <div className="text-xs font-medium text-dark-600">
                            {element}
                          </div>
                          <div
                            className={`text-sm font-mono font-bold ${
                              isDeviated ? "text-yellow-700" : "text-dark-900"
                            }`}
                          >
                            {formatPercentage(value)}
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>
              </div>

              {/* Applied Deviations */}
              {generatedReading.appliedDeviations &&
                generatedReading.appliedDeviations.length > 0 && (
                  <div className="p-4 bg-yellow-50 border border-yellow-300 rounded-lg">
                    <p className="text-sm font-semibold text-yellow-800 mb-2">
                      Applied Deviations:
                    </p>
                    <div className="space-y-1">
                      {generatedReading.appliedDeviations.map((dev) => (
                        <p
                          key={dev.element}
                          className="text-sm text-yellow-700"
                        >
                          <span className="font-mono font-semibold">
                            {dev.element}
                          </span>
                          : {formatPercentage(dev.original)} →{" "}
                          {formatPercentage(dev.deviated)} (
                          {dev.deviationPercent > 0 ? "+" : ""}
                          {dev.deviationPercent.toFixed(1)}%)
                        </p>
                      ))}
                    </div>
                  </div>
                )}

              {/* Metadata */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-dark-600">Temperature:</span>{" "}
                  <span className="font-mono font-semibold text-dark-900">
                    {generatedReading.temperature}°C
                  </span>
                </div>
                <div>
                  <span className="text-dark-600">Pressure:</span>{" "}
                  <span className="font-mono font-semibold text-dark-900">
                    {generatedReading.pressure} atm
                  </span>
                </div>
                <div>
                  <span className="text-dark-600">Source:</span>{" "}
                  <span className="font-semibold text-dark-900">
                    {generatedReading.source || "training_data"}
                  </span>
                </div>
                <div>
                  <span className="text-dark-600">Timestamp:</span>{" "}
                  <span className="font-mono text-dark-900 text-xs">
                    {new Date(generatedReading.timestamp).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </Card>

          {/* Analysis Results */}
          {analysisResult && (
            <Card>
              <h3 className="text-lg font-semibold text-dark-900 mb-4">
                Analysis Results
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Anomaly Status */}
                <div className="p-6 bg-dark-50 rounded-lg">
                  <p className="text-sm font-medium text-dark-600 mb-3">
                    Anomaly Status
                  </p>
                  {analysisResult.severity === "HIGH" ||
                  analysisResult.severity === "MEDIUM" ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-8 h-8 text-red-600" />
                        <span className="text-lg font-bold text-red-600">
                          Anomaly Detected
                        </span>
                      </div>
                      <Badge
                        variant={
                          analysisResult.severity === "HIGH"
                            ? "danger"
                            : "warning"
                        }
                      >
                        {analysisResult.severity}
                      </Badge>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-8 h-8 text-green-600" />
                        <span className="text-lg font-bold text-green-600">
                          Normal
                        </span>
                      </div>
                      <Badge variant="success">
                        {analysisResult.severity || "NORMAL"}
                      </Badge>
                    </div>
                  )}
                </div>

                {/* Anomaly Score */}
                <div className="p-6 bg-dark-50 rounded-lg">
                  <p className="text-sm font-medium text-dark-600 mb-2">
                    Anomaly Score
                  </p>
                  <p className="text-3xl font-bold text-dark-900">
                    {(analysisResult.anomaly_score || 0).toFixed(2)}
                  </p>
                  <div className="mt-3 w-full bg-dark-200 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${
                        (analysisResult.anomaly_score || 0) > 0.5
                          ? "bg-red-500"
                          : "bg-green-500"
                      }`}
                      style={{
                        width: `${Math.min(
                          (analysisResult.anomaly_score || 0) * 100,
                          100
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Message */}
                <div className="p-6 bg-dark-50 rounded-lg">
                  <p className="text-sm font-medium text-dark-600 mb-2">
                    Analysis Message
                  </p>
                  <p className="text-sm text-dark-900">
                    {analysisResult.message || "No message available"}
                  </p>
                </div>
              </div>

              {/* Compliance Info */}
              {analysisResult.compliance && (
                <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm font-semibold text-blue-800 mb-2">
                    Overall Compliance:{" "}
                    <span
                      className={`text-lg ${getComplianceColor(
                        analysisResult.compliance.overallCompliance
                      )}`}
                    >
                      {analysisResult.compliance.overallCompliance?.toFixed(1)}%
                    </span>
                  </p>
                  <p className="text-sm text-blue-700">
                    {analysisResult.compliance.summary?.compliant || 0} /{" "}
                    {analysisResult.compliance.summary?.total || 0} elements
                    within specification
                  </p>
                </div>
              )}

              {/* AI Explanation Button */}
              <div className="mt-6">
                <Button
                  onClick={handleGetAIExplanation}
                  loading={loadingExplanation}
                  disabled={loadingExplanation}
                  className="w-full md:w-auto"
                  variant="success"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  {aiExplanation ? "Regenerate AI Reasoning" : "Get AI Reasoning"}
                </Button>
              </div>
            </Card>
          )}

          {/* AI Explanation Display */}
          {aiExplanation && (
            <Card className="border-2 border-emerald-200">
              <div className="space-y-4">
                <div 
                  className="flex items-center gap-2 text-emerald-700 cursor-pointer hover:bg-emerald-50 p-2 rounded-lg transition-colors"
                  onClick={audioUrl ? handlePlayAudio : undefined}
                  title={audioUrl ? (isPlaying ? 'Click to pause audio' : 'Click to play audio explanation') : 'Audio not available'}
                >
                  <Sparkles className="w-5 h-5" />
                  <h3 className="text-lg font-semibold text-dark-900">
                    Gemini AI Summary
                  </h3>
                  {audioUrl && (
                    isPlaying ? <VolumeX className="w-5 h-5 text-emerald-600" /> : <Volume2 className="w-5 h-5 text-emerald-600" />
                  )}
                  <Badge variant="success" className="ml-auto">
                    Gemini Powered
                  </Badge>
                </div>
                
                <div className="bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-200 rounded-lg p-6">
                  <div className="prose prose-sm max-w-none">
                    <div className="text-dark-800 whitespace-pre-wrap leading-relaxed">
                      {aiExplanation}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      {/* Copilot Explanation */}
      {copilotExplanation && <ExplanationCard explanation={copilotExplanation} />}

      {/* Empty State */}
      {!generatedReading && !analyzing && (
        <Card className="text-center py-12">
          <AlertTriangle className="w-16 h-16 text-dark-400 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-dark-900 mb-2">
            No Data Generated
          </h3>
          <p className="text-dark-600">
            Generate a synthetic reading to begin anomaly detection
          </p>
        </Card>
      )}

      {/* AI Chat Button */}
      {analysisResult && (
        <button
          onClick={() => setIsChatOpen(!isChatOpen)}
          className="fixed bottom-6 right-6 bg-emerald-600 hover:bg-emerald-700 text-white rounded-full p-4 shadow-lg transition-all duration-200 hover:scale-110 z-40"
          title="Open AI Copilot Chat"
        >
          <MessageCircle className="w-6 h-6" />
        </button>
      )}

      {/* AI Chat Interface */}
      <AIChatInterface isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
    </div>
  );
};

export default AnomalyDetection;
