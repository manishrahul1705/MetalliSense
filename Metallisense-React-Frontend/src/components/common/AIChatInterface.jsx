import { useState, useRef, useEffect } from "react";
import Card from "./Card";
import Button from "./Button";
import {
  sendChatMessage,
  transcribeAudio,
  clearChatHistory,
} from "../../services/copilotService";
import toast from "react-hot-toast";

const AIChatInterface = ({ isOpen, onClose }) => {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async (messageText = inputMessage) => {
    if (!messageText.trim() || isLoading) return;

    const userMessage = { role: "user", content: messageText };
    setMessages((prev) => [...prev, userMessage]);
    setInputMessage("");
    setIsLoading(true);

    try {
      const response = await sendChatMessage(messageText, true);
      const aiMessage = {
        role: "assistant",
        content: response.data.response,
      };
      setMessages((prev) => [...prev, aiMessage]);
    } catch (error) {
      console.error("Chat error:", error);
      toast.error("Failed to get response from AI");
      const errorMessage = {
        role: "assistant",
        content: "I apologize, but I encountered an error. Please try again.",
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearChatHistory();
      setMessages([]);
      toast.success("Chat history cleared");
    } catch (error) {
      console.error("Clear history error:", error);
      toast.error("Failed to clear history");
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/webm",
        });
        await handleTranscribeAudio(audioBlob);
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error("Recording error:", error);
      toast.error("Failed to access microphone");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleTranscribeAudio = async (audioBlob) => {
    setIsTranscribing(true);
    try {
      const audioFile = new File([audioBlob], "recording.webm", {
        type: "audio/webm",
      });
      const response = await transcribeAudio(audioFile);
      const transcribedText = response.data.text;
      setInputMessage(transcribedText);
      toast.success("Voice transcribed successfully");
    } catch (error) {
      console.error("Transcription error:", error);
      toast.error("Failed to transcribe audio");
    } finally {
      setIsTranscribing(false);
    }
  };

  const suggestedQuestions = [
    "What do these composition values mean?",
    "Why is this grade recommended?",
    "What should I check next?",
    "Explain the confidence score",
  ];

  if (!isOpen) return null;

  return (
    <div className="fixed bottom-4 right-4 w-96 h-[32rem] flex flex-col bg-white rounded-lg shadow-2xl border border-gray-200 z-50">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-emerald-600 rounded-t-lg">
        <h3 className="font-semibold text-white">AI Copilot</h3>
        <div className="flex gap-2">
          <button
            onClick={handleClearHistory}
            className="text-white hover:bg-emerald-700 p-1 rounded transition-colors"
            title="Clear history"
          >
            🗑️
          </button>
          <button
            onClick={onClose}
            className="text-white hover:bg-emerald-700 p-1 rounded transition-colors"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 mt-8">
            <p className="mb-4">👋 Hi! I'm your AI assistant.</p>
            <p className="text-sm">Ask me anything about your analysis!</p>
            <div className="mt-6 space-y-2">
              <p className="text-xs font-medium text-gray-600">
                Suggested questions:
              </p>
              {suggestedQuestions.map((question, index) => (
                <button
                  key={index}
                  onClick={() => handleSendMessage(question)}
                  className="block w-full text-left text-sm text-emerald-600 hover:bg-emerald-50 p-2 rounded transition-colors"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, index) => (
            <div
              key={index}
              className={`flex ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[80%] p-3 rounded-lg ${
                  message.role === "user"
                    ? "bg-emerald-600 text-white"
                    : "bg-gray-100 text-gray-900"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">
                  {message.content}
                </p>
              </div>
            </div>
          ))
        )}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 p-3 rounded-lg">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                <span
                  className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.1s" }}
                />
                <span
                  className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.2s" }}
                />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-200">
        {isTranscribing && (
          <div className="mb-2 text-sm text-emerald-600 flex items-center gap-2">
            <span className="animate-pulse">🎤</span> Transcribing...
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
            placeholder="Ask me anything..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
            disabled={isLoading || isTranscribing}
          />
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`p-2 rounded-lg transition-colors ${
              isRecording
                ? "bg-red-500 hover:bg-red-600 text-white animate-pulse"
                : "bg-gray-200 hover:bg-gray-300 text-gray-700"
            }`}
            title={isRecording ? "Stop recording" : "Start recording"}
            disabled={isTranscribing}
          >
            🎤
          </button>
          <Button
            onClick={() => handleSendMessage()}
            disabled={isLoading || !inputMessage.trim() || isTranscribing}
            size="sm"
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
};

export default AIChatInterface;
