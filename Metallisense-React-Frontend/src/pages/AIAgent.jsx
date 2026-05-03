import React, { useState, useRef } from "react";
import Card from "../components/common/Card";
import Badge from "../components/common/Badge";
import Button from "../components/common/Button";
import SyntheticGenerator from "../components/common/SyntheticGenerator";
import { analyzeAgent } from "../services/aiService";
import { Sparkles, Volume2, VolumeX } from "lucide-react";
import toast from "react-hot-toast";
import { formatPercentage } from "../utils/formatters";

// ─── Helper: call Claude securely via your backend proxy ──────────────────────
async function callClaude({ messages, system, max_tokens = 1000 }) {
  let response;

  try {
    response = await fetch("/api/claude-explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens,
        ...(system ? { system } : {}),
        messages,
      }),
    });
  } catch (networkErr) {
    throw new Error(
      `Network error: cannot reach /api/claude-explain. Is your backend running? (${networkErr.message})`
    );
  }

  // Read raw text first — prevents "Unexpected end of JSON input"
  const raw = await response.text();

  if (!raw || raw.trim() === "") {
    throw new Error(
      `Backend returned an empty response (HTTP ${response.status}). Check your server logs.`
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Backend returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`
    );
  }

  if (!response.ok) {
    throw new Error(data?.error || `Claude proxy failed with HTTP ${response.status}`);
  }

  return (data.content || [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

// ─── Component ────────────────────────────────────────────────────────────────
const AIAgent = () => {
  const [syntheticReading, setSyntheticReading] = useState(null);
  const [result, setResult] = useState(null);
  const [aiAvailable, setAIAvailable] = useState(true);
  const [aiExplanation, setAiExplanation] = useState(null);
  const [loadingExplanation, setLoadingExplanation] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const utteranceRef = useRef(null);

  // ─── Generate & run backend AI agent ────────────────────────────────────────
  const handleGenerate = async (reading, params) => {
    console.log("AI Agent: handleGenerate called with:", { reading, params });

    setSyntheticReading(reading);
    setResult(null);
    setAiExplanation(null);
    setIsPlaying(false);
    if (window.speechSynthesis) window.speechSynthesis.cancel();

    try {
      const requestData = {
        metalGrade: reading.metalGrade,
        composition: reading.composition,
      };

      console.log("AI Agent: Sending to AI:", requestData);

      const response = await analyzeAgent(requestData);
      console.log("AI Agent: Response:", response.data);

      const data = response.data.data;
      setResult(data);

      if (!data.aiAnalysis.serviceAvailable) {
        setAIAvailable(false);
        toast.warning(
          "AI Agent service is experiencing issues. Results may be incomplete."
        );
      } else {
        setAIAvailable(true);
        toast.success("AI Agent analysis completed successfully");
      }
    } catch (error) {
      console.error("AI Agent analysis failed:", error);
      toast.error(
        error.response?.data?.message || "Failed to complete AI Agent analysis"
      );
    }
  };

  // ─── Claude explanation via backend proxy ────────────────────────────────────
  const handleGetAIExplanation = async () => {
    if (!result || !syntheticReading) {
      toast.error("No results to explain");
      return;
    }

    setLoadingExplanation(true);
    setAiExplanation(null);

    try {
      const anomalyAgent = result.aiAnalysis?.agentResponse?.anomaly_agent || {};
      const alloyAgent   = result.aiAnalysis?.agentResponse?.alloy_agent   || {};
      const finalRec     = result.aiAnalysis?.agentResponse?.final_recommendation || "";

      const userPrompt = `Analyze the following metal composition data and AI agent results, then provide a clear, detailed explanation.

Metal Grade: ${syntheticReading.metalGrade}
Composition: ${JSON.stringify(syntheticReading.composition, null, 2)}

Anomaly Detection Results:
- Severity: ${anomalyAgent.severity || "N/A"}
- Anomaly Score: ${anomalyAgent.anomaly_score ?? "N/A"}
- Confidence: ${anomalyAgent.confidence ?? "N/A"}

Alloy Correction Results:
- Recommended Additions: ${JSON.stringify(alloyAgent.recommended_additions || {}, null, 2)}
- Confidence: ${alloyAgent.confidence ?? "N/A"}
- Explanation: ${alloyAgent.explanation || "N/A"}

Final Recommendation: ${finalRec}

Please provide:
1. A summary of what the anomaly detection found and what it means
2. An explanation of the recommended alloy corrections and why they are needed
3. Practical next steps for the metallurgist
4. Any risks or considerations to be aware of

Keep the explanation professional, clear, and actionable.`;

      const explanation = await callClaude({
        system:
          "You are an expert metallurgist AI assistant. Respond in clear, structured sections. Be professional and actionable.",
        messages: [{ role: "user", content: userPrompt }],
        max_tokens: 1200,
      });

      // Prepend anomaly explanation if available
      const anomalyExplanation =
        result.aiAnalysis?.anomalyDetection?.anomaly?.explanation || "";
      const combinedExplanation = anomalyExplanation
        ? `Analysis:\n${anomalyExplanation}\n\nDetailed AI Reasoning:\n${explanation}`
        : explanation;

      setTimeout(() => setAiExplanation(combinedExplanation), 400);
      toast.success("Claude AI explanation generated successfully");
    } catch (error) {
      console.error("Failed to get Claude AI explanation:", error);
      toast.error(error.message || "Failed to generate AI explanation");
    } finally {
      setLoadingExplanation(false);
    }
  };

  // ─── Browser TTS ─────────────────────────────────────────────────────────────
  const handlePlayAudio = () => {
    if (!aiExplanation) return;

    if (isPlaying) {
      window.speechSynthesis.cancel();
      setIsPlaying(false);
      utteranceRef.current = null;
    } else {
      const utterance = new SpeechSynthesisUtterance(aiExplanation);
      utterance.rate = 0.95;
      utterance.onend  = () => { setIsPlaying(false); utteranceRef.current = null; };
      utterance.onerror = () => { setIsPlaying(false); utteranceRef.current = null; };
      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
      setIsPlaying(true);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-dark-900">AI Agent Analysis</h1>
          <p className="text-dark-600 mt-1">
            Coordinated AI agent with combined insights, quality assessment, and
            actionable recommendations
          </p>
        </div>

        {/* AI Status Badge */}
        <div
          className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
            aiAvailable ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              aiAvailable ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span className="font-medium text-sm">
            AI Agent: {aiAvailable ? "Online" : "Offline"}
          </span>
        </div>
      </div>

      {/* Synthetic Generator */}
      <SyntheticGenerator
        onDataGenerated={handleGenerate}
        buttonText="Generate & Run AI Agent Analysis"
      />

      {/* Results */}
      {result && (
        <div className="space-y-6">
          {/* AI Service Warning */}
          {!result.aiAnalysis.serviceAvailable && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-red-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-red-800">
                    AI Agent Service Unavailable
                  </h3>
                  <p className="text-sm text-red-700 mt-1">
                    The AI Agent service is currently offline. Human approval required for all decisions.
                  </p>
                  {result.aiAnalysis.error && (
                    <p className="text-xs text-red-600 mt-2 font-mono">
                      Error: {result.aiAnalysis.error}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Final Recommendation */}
          {result.aiAnalysis.agentResponse?.final_recommendation && (
            <Card title="Final Recommendation">
              <div className="p-6 bg-gradient-to-r from-primary-50 to-primary-100 border-l-4 border-primary-500 rounded-lg">
                <p className="text-2xl font-bold text-primary-900">
                  {result.aiAnalysis.agentResponse.final_recommendation}
                </p>
              </div>
            </Card>
          )}

          {/* Anomaly Agent Analysis */}
          {result.aiAnalysis.agentResponse?.anomaly_agent && (
            <Card title="Anomaly Detection Analysis">
              {(() => {
                const anomaly = result.aiAnalysis.agentResponse.anomaly_agent;
                const severity = anomaly.severity;

                const severityStyles = {
                  LOW: {
                    bg: "bg-green-50", border: "border-green-300",
                    text: "text-green-700", badge: "success", bar: "bg-green-500",
                  },
                  MEDIUM: {
                    bg: "bg-yellow-50", border: "border-yellow-300",
                    text: "text-yellow-700", badge: "warning", bar: "bg-yellow-500",
                  },
                  HIGH: {
                    bg: "bg-red-50", border: "border-red-300",
                    text: "text-red-700", badge: "danger", bar: "bg-red-500",
                  },
                };

                const style = severityStyles[severity] || severityStyles.MEDIUM;

                return (
                  <div className="space-y-6">
                    {/* Severity Banner */}
                    <div className={`p-5 rounded-xl border-2 ${style.bg} ${style.border}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-dark-600 mb-1">
                            Anomaly Severity
                          </p>
                          <Badge variant={style.badge} className="text-lg px-4 py-1">
                            {severity}
                          </Badge>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-dark-600 mb-1">Anomaly Score</p>
                          <p className={`text-3xl font-bold ${style.text}`}>
                            {anomaly.anomaly_score?.toFixed(3) || "N/A"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-4">
                        <div className="h-2 w-full bg-dark-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${style.bar}`}
                            style={{
                              width: `${Math.min((anomaly.anomaly_score || 0) * 100, 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Metrics */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="p-5 bg-dark-50 border border-dark-200 rounded-lg">
                        <p className="text-sm text-dark-600 mb-2">Detection Confidence</p>
                        <div className="flex items-center gap-4">
                          <div className="flex-1 bg-dark-200 rounded-full h-3">
                            <div
                              className={`h-3 rounded-full ${style.bar}`}
                              style={{ width: `${(anomaly.confidence || 0) * 100}%` }}
                            />
                          </div>
                          <span className={`text-xl font-bold ${style.text}`}>
                            {((anomaly.confidence || 0) * 100).toFixed(1)}%
                          </span>
                        </div>
                      </div>

                      <div className="p-5 bg-dark-50 border border-dark-200 rounded-lg">
                        <p className="text-sm text-dark-600 mb-2">System Interpretation</p>
                        <p className="text-sm font-medium text-dark-900">
                          {severity === "HIGH"
                            ? "Critical deviation detected"
                            : severity === "MEDIUM"
                            ? "Moderate deviation observed"
                            : "Composition within acceptable variance"}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </Card>
          )}

          {/* Alloy Agent Analysis */}
          {result.aiAnalysis.agentResponse?.alloy_agent && (
            <Card title="Alloy Correction Analysis">
              <div className="space-y-4">
                {result.aiAnalysis.agentResponse.alloy_agent.recommended_additions &&
                  Object.keys(result.aiAnalysis.agentResponse.alloy_agent.recommended_additions).length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-dark-700 mb-3">
                        Recommended Element Adjustments
                      </h4>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                        {Object.entries(
                          result.aiAnalysis.agentResponse.alloy_agent.recommended_additions
                        ).map(([element, value]) => (
                          <div
                            key={element}
                            className={`p-3 rounded-lg border-2 ${
                              value > 0
                                ? "bg-green-50 border-green-200"
                                : value < 0
                                ? "bg-red-50 border-red-200"
                                : "bg-gray-50 border-gray-200"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-mono font-bold text-dark-900">
                                {element}
                              </span>
                              {value !== 0 && (
                                <Badge
                                  variant={value > 0 ? "success" : "danger"}
                                  className="text-xs"
                                >
                                  {value > 0 ? "Add" : "Reduce"}
                                </Badge>
                              )}
                            </div>
                            <p
                              className={`text-xl font-bold ${
                                value > 0
                                  ? "text-green-600"
                                  : value < 0
                                  ? "text-red-600"
                                  : "text-gray-500"
                              }`}
                            >
                              {value > 0 ? "+" : ""}
                              {formatPercentage(value)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                {result.aiAnalysis.agentResponse.alloy_agent.confidence != null && (
                  <div className="p-4 bg-dark-50 rounded-lg">
                    <p className="text-sm text-dark-600 mb-2">Correction Confidence</p>
                    <div className="flex items-center gap-4">
                      <div className="flex-1 bg-dark-200 rounded-full h-4">
                        <div
                          className="h-4 rounded-full bg-primary-500 transition-all duration-500"
                          style={{
                            width: `${(result.aiAnalysis.agentResponse.alloy_agent.confidence || 0) * 100}%`,
                          }}
                        />
                      </div>
                      <span className="text-xl font-bold text-primary-600 min-w-[70px] text-right">
                        {(result.aiAnalysis.agentResponse.alloy_agent.confidence * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                )}

                {result.aiAnalysis.agentResponse.alloy_agent.explanation && (
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-sm text-green-900">
                      {result.aiAnalysis.agentResponse.alloy_agent.explanation}
                    </p>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Quality Assessment */}
          {result.aiAnalysis.agentResponse?.quality_assessment && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {result.aiAnalysis.agentResponse.quality_assessment.issues?.length > 0 && (
                <Card title="⚠️ Issues Detected">
                  <div className="space-y-3">
                    {result.aiAnalysis.agentResponse.quality_assessment.issues.map(
                      (issue, index) => (
                        <div
                          key={index}
                          className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg"
                        >
                          <div className="flex items-start gap-2">
                            <Badge variant="warning" className="mt-0.5">
                              {issue.element}
                            </Badge>
                            <div className="flex-1">
                              <p className="font-medium text-yellow-900">{issue.issue}</p>
                              <p className="text-sm text-yellow-700 mt-1">
                                Severity: <span className="font-semibold">{issue.severity}</span>
                              </p>
                              {issue.impact && (
                                <p className="text-xs text-yellow-600 mt-1">Impact: {issue.impact}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                </Card>
              )}

              {result.aiAnalysis.agentResponse.quality_assessment.strengths?.length > 0 && (
                <Card title="✅ Strengths">
                  <div className="space-y-2">
                    {result.aiAnalysis.agentResponse.quality_assessment.strengths.map(
                      (strength, index) => (
                        <div
                          key={index}
                          className="flex items-start gap-2 p-3 bg-green-50 border border-green-200 rounded-lg"
                        >
                          <svg className="w-5 h-5 text-green-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                              clipRule="evenodd"
                            />
                          </svg>
                          <p className="text-sm text-green-800">{strength}</p>
                        </div>
                      )
                    )}
                  </div>
                </Card>
              )}
            </div>
          )}

          {/* Suggested Actions */}
          {result.aiAnalysis.agentResponse?.suggested_actions?.length > 0 && (
            <Card title="📋 Suggested Actions">
              <div className="space-y-3">
                {result.aiAnalysis.agentResponse.suggested_actions.map((action, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-3 p-4 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 transition-colors"
                  >
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary-500 text-white font-bold text-sm flex-shrink-0">
                      {index + 1}
                    </div>
                    <p className="text-dark-800 flex-1 pt-1">{action}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Generated Composition */}
          <Card title="Generated Synthetic Reading">
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-dark-200">
                <div>
                  <h3 className="text-sm font-medium text-dark-600">Metal Grade</h3>
                  <p className="text-lg font-bold text-dark-900 font-mono">
                    {syntheticReading.metalGrade}
                  </p>
                </div>
                <div className="text-right">
                  <h3 className="text-sm font-medium text-dark-600">Deviation Applied</h3>
                  <p className="text-lg font-bold text-primary-600">
                    {syntheticReading.deviationPercentage}%
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {Object.entries(syntheticReading.composition).map(([element, value]) => {
                  const isDeviated = syntheticReading.deviationElements?.includes(element);
                  return (
                    <div
                      key={element}
                      className={`p-3 rounded-lg ${
                        isDeviated
                          ? "bg-yellow-50 border-2 border-yellow-300"
                          : "bg-dark-50 border border-dark-200"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono font-bold text-sm text-dark-900">
                          {element}
                        </span>
                        {isDeviated && (
                          <Badge variant="warning" className="text-xs">Deviated</Badge>
                        )}
                      </div>
                      <p className="text-lg font-bold text-dark-900">
                        {formatPercentage(value)}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>

          {/* AI Explanation Button */}
          <div className="flex justify-center">
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

          {/* Claude AI Explanation Display */}
          {aiExplanation && (
            <Card className="border-2 border-emerald-200">
              <div className="space-y-4">
                <div
                  className="flex items-center gap-2 text-emerald-700 cursor-pointer hover:bg-emerald-50 p-2 rounded-lg transition-colors"
                  onClick={handlePlayAudio}
                  title={isPlaying ? "Click to pause audio" : "Click to play audio explanation"}
                >
                  <Sparkles className="w-5 h-5" />
                  <h3 className="text-lg font-semibold text-dark-900">Claude AI Summary</h3>
                  {isPlaying ? (
                    <VolumeX className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <Volume2 className="w-5 h-5 text-emerald-600" />
                  )}
                  <Badge variant="success" className="ml-auto">Claude Powered</Badge>
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
        </div>
      )}
    </div>
  );
};

export default AIAgent;