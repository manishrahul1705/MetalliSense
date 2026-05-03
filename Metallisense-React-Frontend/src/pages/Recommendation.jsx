import React, { useState, useRef } from "react";
import Card from "../components/common/Card";
import Badge from "../components/common/Badge";
import Button from "../components/common/Button";
import SyntheticGenerator from "../components/common/SyntheticGenerator";
import ExplanationCard from "../components/common/ExplanationCard";
import AIChatInterface from "../components/common/AIChatInterface";
import { analyzeIndividual } from "../services/aiService";
import { getExplanation } from "../services/copilotService";
import { Sparkles, Volume2, VolumeX, MessageCircle } from "lucide-react";
import toast from "react-hot-toast";
import { formatPercentage, formatConfidence } from "../utils/formatters";

const Recommendation = () => {
  const [syntheticReading, setSyntheticReading] = useState(null);
  const [result, setResult] = useState(null);
  const [aiAvailable, setAIAvailable] = useState(true);
  const [aiExplanation, setAiExplanation] = useState(null);
  const [loadingExplanation, setLoadingExplanation] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copilotExplanation, setCopilotExplanation] = useState(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const audioRef = useRef(null);

  const handleGenerate = async (reading, params) => {
    console.log("handleGenerate called with:", { reading, params });

    setSyntheticReading(reading);
    setAiExplanation(null);
    setCopilotExplanation(null);
    setAudioUrl(null);
    setIsPlaying(false);

    try {
      const requestData = {
        metalGrade: reading.metalGrade,
        composition: reading.composition,
      };

      console.log("Sending to AI:", requestData);

      const response = await analyzeIndividual(requestData);

      console.log("AI Response:", response.data);

      const data = response.data.data;
      setResult(data);

      // Auto-generate copilot explanation
      await generateCopilotExplanation(reading, data);

      if (!data.aiAnalysis.serviceAvailable) {
        setAIAvailable(false);
        toast.custom((t) => (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 shadow-lg">
            <div className="flex items-center gap-2">
              <span className="text-2xl">⚠️</span>
              <span className="text-amber-800">
                AI service is experiencing issues. Results may be incomplete.
              </span>
            </div>
          </div>
        ));
      } else {
        setAIAvailable(true);
        toast.success("Alloy recommendation generated successfully");
      }
    } catch (error) {
      console.error("Recommendation failed:", error);
      console.error("Error details:", error.response?.data);
      toast.error(
        error.response?.data?.message || "Failed to generate recommendation"
      );
    }
  };

  const generateCopilotExplanation = async (reading, resultData) => {
    try {
      const response = await getExplanation({
        composition: reading.composition,
        grade: reading.metalGrade,
        analysisResult: resultData,
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
    if (!result || !syntheticReading) {
      toast.error("No results to explain");
      return;
    }

    await generateCopilotExplanation(syntheticReading, result);
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-dark-900">
            Alloy Recommendations
          </h1>
          <p className="text-dark-600 mt-1">
            Generate synthetic readings and get AI-powered alloy addition
            recommendations
          </p>
        </div>

        {/* AI Status Badge */}
        <div
          className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
            aiAvailable
              ? "bg-green-50 text-green-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              aiAvailable ? "bg-green-500" : "bg-red-500"
            }`}
          ></span>
          <span className="font-medium text-sm">
            AI Service: {aiAvailable ? "Online" : "Offline"}
          </span>
        </div>
      </div>

      {/* Synthetic Generator */}
      <SyntheticGenerator
        onDataGenerated={handleGenerate}
        buttonText="Generate & Get Recommendations"
      />

      {/* Results */}
      {result && (
        <div className="space-y-6">
          {/* AI Service Warning */}
          {!result.aiAnalysis.serviceAvailable && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-yellow-600 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-yellow-800">
                    AI Service Unavailable
                  </h3>
                  <p className="text-sm text-yellow-700 mt-1">
                    The recommendation system is currently offline. Results
                    shown are incomplete or unavailable.
                  </p>
                  {result.aiAnalysis.errors?.alloy && (
                    <p className="text-xs text-yellow-600 mt-2 font-mono">
                      Error: {result.aiAnalysis.errors.alloy}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Recommended Additions */}
          {result.aiAnalysis.alloyRecommendation.recommended_additions &&
            Object.keys(
              result.aiAnalysis.alloyRecommendation.recommended_additions
            ).length > 0 && (
              <Card title="Recommended Alloy Additions">
                <div className="space-y-4">
                  <p className="text-sm text-dark-600 mb-4">
                    The following element adjustments are recommended to
                    optimize the composition:
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    {Object.entries(
                      result.aiAnalysis.alloyRecommendation
                        .recommended_additions
                    ).map(([element, value]) => (
                      <div
                        key={element}
                        className={`p-4 rounded-lg border-2 ${
                          value > 0
                            ? "bg-green-50 border-green-200"
                            : value < 0
                            ? "bg-red-50 border-red-200"
                            : "bg-gray-50 border-gray-200"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-mono font-bold text-lg text-dark-900">
                            {element}
                          </span>
                          {value !== 0 && (
                            <Badge variant={value > 0 ? "success" : "danger"}>
                              {value > 0 ? "Add" : "Reduce"}
                            </Badge>
                          )}
                        </div>
                        <p
                          className={`text-2xl font-bold ${
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
              </Card>
            )}

          {/* Alternative Grades */}
          {result.aiAnalysis.alloyRecommendation.alternative_grades &&
            result.aiAnalysis.alloyRecommendation.alternative_grades.length >
              0 && (
              <Card title="Alternative Grades">
                <p className="text-sm text-dark-600 mb-4">
                  Other suitable grades based on the composition:
                </p>
                <div className="grid gap-3">
                  {result.aiAnalysis.alloyRecommendation.alternative_grades.map(
                    (grade, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-4 bg-dark-50 rounded-lg hover:bg-dark-100 transition-colors border border-dark-200"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary-100 text-primary-600 font-bold">
                            {index + 1}
                          </div>
                          <span className="text-lg font-semibold text-dark-900 font-mono">
                            {typeof grade === "string" ? grade : grade.name}
                          </span>
                        </div>
                        {typeof grade === "object" && grade.confidence && (
                          <Badge variant="info">
                            {formatConfidence(grade.confidence)}
                          </Badge>
                        )}
                      </div>
                    )
                  )}
                </div>
              </Card>
            )}

          {/* Notes/Explanation - Now shown via Get AI Reasoning button */}

          {/* Synthetic Reading Details */}
          <Card title="Generated Composition">
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-dark-200">
                <div>
                  <h3 className="text-sm font-medium text-dark-600">
                    Metal Grade
                  </h3>
                  <p className="text-lg font-bold text-dark-900 font-mono">
                    {syntheticReading.metalGrade}
                  </p>
                </div>
                <div className="text-right">
                  <h3 className="text-sm font-medium text-dark-600">
                    Deviation Applied
                  </h3>
                  <p className="text-lg font-bold text-primary-600">
                    {syntheticReading.deviationPercentage}%
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {Object.entries(syntheticReading.composition).map(
                  ([element, value]) => {
                    const isDeviated =
                      syntheticReading.deviationElements?.includes(element);
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
                            <Badge variant="warning" className="text-xs">
                              Deviated
                            </Badge>
                          )}
                        </div>
                        <p className="text-lg font-bold text-dark-900">
                          {formatPercentage(value)}
                        </p>
                      </div>
                    );
                  }
                )}
              </div>

              {/* Applied Deviations Details */}
              {syntheticReading.appliedDeviations &&
                syntheticReading.appliedDeviations.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-dark-200">
                    <h3 className="text-sm font-medium text-dark-700 mb-3">
                      Applied Deviations
                    </h3>
                    <div className="grid gap-2">
                      {syntheticReading.appliedDeviations.map(
                        (deviation, index) => (
                          <div
                            key={index}
                            className="flex items-center justify-between p-2 bg-yellow-50 rounded text-sm"
                          >
                            <span className="font-mono font-bold text-dark-900">
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
                                  {aiExplanation
                                    ? "Regenerate AI Reasoning"
                                    : "Get AI Reasoning"}
                                </Button>
                              </div>

                              {/* AI Explanation Display */}
                              {aiExplanation && (
                                <Card className="border-2 border-emerald-200">
                                  <div className="space-y-4">
                                    <div
                                      className="flex items-center gap-2 text-emerald-700 cursor-pointer hover:bg-emerald-50 p-2 rounded-lg transition-colors"
                                      onClick={
                                        audioUrl ? handlePlayAudio : undefined
                                      }
                                      title={
                                        audioUrl
                                          ? isPlaying
                                            ? "Click to pause audio"
                                            : "Click to play audio explanation"
                                          : "Audio not available"
                                      }
                                    >
                                      <Sparkles className="w-5 h-5" />
                                      <h3 className="text-lg font-semibold text-dark-900">
                                        Gemini AI Summary
                                      </h3>
                                      {audioUrl &&
                                        (isPlaying ? (
                                          <VolumeX className="w-5 h-5 text-emerald-600" />
                                        ) : (
                                          <Volume2 className="w-5 h-5 text-emerald-600" />
                                        ))}
                                      <Badge
                                        variant="success"
                                        className="ml-auto"
                                      >
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
                              {deviation.element}
                            </span>
                            <div className="flex items-center gap-3 text-dark-700">
                              <span>
                                {formatPercentage(deviation.original)}
                              </span>
                              <span>→</span>
                              <span className="font-bold text-yellow-700">
                                {formatPercentage(deviation.deviated)}
                              </span>
                              <Badge variant="warning" className="text-xs">
                                {deviation.deviationPercent > 0 ? "+" : ""}
                                {deviation.deviationPercent.toFixed(2)}%
                              </Badge>
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}
            </div>
          </Card>
        </div>
      )}

      {/* Copilot Explanation */}
      {copilotExplanation && <ExplanationCard explanation={copilotExplanation} />}

      {/* AI Chat Button */}
      {result && (
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

export default Recommendation;
