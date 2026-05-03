import axios from "axios";

// Separate axios instance for copilot service (different base URL)
const copilotApi = axios.create({
  baseURL: import.meta.env.VITE_COPILOT_BASE_URL || "http://localhost:8001",
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

/**
 * Get explanation for analysis results
 * @param {Object} data - { composition: {}, grade: string }
 * @returns {Promise} Explanation response
 */
export const getExplanation = (data) =>
  copilotApi.post("/copilot/explain", data);

/**
 * Send chat message to AI copilot
 * @param {string} message - User's question
 * @param {boolean} includeContext - Include latest analysis context
 * @returns {Promise} Chat response
 */
export const sendChatMessage = (message, includeContext = true) =>
  copilotApi.post("/copilot/chat", {
    message,
    include_context: includeContext,
  });

/**
 * Clear conversation history
 * @returns {Promise} Success response
 */
export const clearChatHistory = () =>
  copilotApi.delete("/copilot/chat/history");

/**
 * Transcribe audio to text (Speech-to-Text)
 * @param {File} audioFile - Audio file to transcribe
 * @param {string} language - Language code (e.g., "en")
 * @returns {Promise} Transcription response
 */
export const transcribeAudio = (audioFile, language = "en") => {
  const formData = new FormData();
  formData.append("audio", audioFile);
  if (language) {
    formData.append("language", language);
  }

  return copilotApi.post("/copilot/voice/transcribe", formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
};

/**
 * Synthesize text to speech (Text-to-Speech)
 * @param {string} text - Text to convert to speech
 * @param {string} language - Language code
 * @param {boolean} slow - Speak slowly
 * @returns {Promise} Audio blob
 */
export const synthesizeSpeech = async (text, language = "en", slow = false) => {
  const response = await copilotApi.post(
    "/copilot/voice/synthesize",
    {
      text,
      language,
      slow,
    },
    {
      responseType: "blob",
    }
  );
  return response.data;
};

/**
 * Get supported languages for voice services
 * @returns {Promise} Languages object
 */
export const getSupportedLanguages = () =>
  copilotApi.get("/copilot/voice/languages");

/**
 * Check copilot service health
 * @returns {Promise} Health status
 */
export const checkCopilotHealth = () => copilotApi.get("/health");
