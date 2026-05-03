import { useState, useEffect } from "react";
import { Beaker, AlertCircle } from "lucide-react";
import Select from "./Select";
import Input from "./Input";
import Button from "./Button";
import Card from "./Card";
import { getAllGrades, getGradeComposition } from "../../services/gradeService";
import { generateSyntheticReading } from "../../services/opcService";
import { useOPC } from "../../context/OPCContext";
import toast from "react-hot-toast";

/**
 * Reusable component for generating synthetic spectrometer readings
 * Used in AnomalyDetection, SyntheticData, AIAgent, and other pages
 */
const SyntheticGenerator = ({
  onDataGenerated,
  buttonText = "Generate Synthetic Reading",
  className = "",
  autoGenerate = false,
}) => {
  const [selectedGrade, setSelectedGrade] = useState("");
  const [gradeNames, setGradeNames] = useState([]);
  const [availableElements, setAvailableElements] = useState([]);
  const [deviationElements, setDeviationElements] = useState([]);
  const [deviationPercentage, setDeviationPercentage] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [loadingGrades, setLoadingGrades] = useState(true);
  const [loadingElements, setLoadingElements] = useState(false);
  const { status: opcStatus } = useOPC();

  // Fetch all grade names on mount
  useEffect(() => {
    const fetchGrades = async () => {
      setLoadingGrades(true);
      try {
        const response = await getAllGrades();
        const grades = response.data.data?.data || [];
        const names = grades.map((g) => g.grade);
        setGradeNames(names);
      } catch (error) {
        console.error("Failed to fetch grade names:", error);
        toast.error("Failed to load metal grades");
      } finally {
        setLoadingGrades(false);
      }
    };

    fetchGrades();
  }, []);

  // Fetch available elements when grade changes
  useEffect(() => {
    if (!selectedGrade) {
      setAvailableElements([]);
      setDeviationElements([]);
      return;
    }

    const fetchElements = async () => {
      setLoadingElements(true);
      try {
        const response = await getGradeComposition(selectedGrade);
        const compositionRanges = response.data.data?.composition_ranges || {};
        const elements = Object.keys(compositionRanges);
        setAvailableElements(elements);
        setDeviationElements([]); // Reset deviation selection
      } catch (error) {
        console.error("Failed to fetch elements:", error);
        toast.error("Failed to load elements for selected grade");
        setAvailableElements([]);
      } finally {
        setLoadingElements(false);
      }
    };

    fetchElements();
  }, [selectedGrade]);

  const toggleDeviationElement = (element) => {
    setDeviationElements((prev) =>
      prev.includes(element)
        ? prev.filter((el) => el !== element)
        : [...prev, element]
    );
  };

  const handleGenerate = async () => {
    console.log("OPC Status:", opcStatus);
    if (!opcStatus?.connected) {
      toast.error(
        "OPC Server must be connected to generate synthetic readings"
      );
      return;
    }
    if (!selectedGrade) {
      toast.error("Please select a metal grade");
      return;
    }
    if (deviationElements.length === 0) {
      toast.error("Please select at least one deviation element");
      return;
    }

    setGenerating(true);
    try {
      const requestData = {
        metalGrade: selectedGrade,
        deviationElements: deviationElements,
        deviationPercentage: deviationPercentage,
      };

      const response = await generateSyntheticReading(requestData);

      if (response.data) {
        const reading = response.data.data?.reading || response.data.reading;
        toast.success("Synthetic reading generated successfully");

        if (onDataGenerated) {
          onDataGenerated(reading, requestData);
        }
      }
    } catch (error) {
      console.error("Failed to generate synthetic reading:", error);
      const errorMsg =
        error.response?.data?.message || "Failed to generate synthetic reading";
      toast.error(errorMsg);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Card className={className}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-primary-700">
          <Beaker className="w-5 h-5" />
          <h3 className="font-semibold text-dark-900">
            Synthetic Reading Generator
          </h3>
        </div>

        <div className="space-y-4">
          {/* Grade Selection */}
          <Select
            label="Select Metal Grade"
            value={selectedGrade}
            onChange={(e) => setSelectedGrade(e.target.value)}
            options={[
              {
                value: "",
                label: loadingGrades ? "Loading grades..." : "Choose grade...",
              },
              ...gradeNames.map((name) => ({
                value: name,
                label: name,
              })),
            ]}
            disabled={loadingGrades}
            required
          />

          {/* Deviation Elements Selection */}
          {selectedGrade && (
            <div>
              <label className="block text-sm font-medium text-dark-700 mb-3">
                Deviation Elements{" "}
                {loadingElements && (
                  <span className="text-dark-500">(Loading...)</span>
                )}
              </label>
              {availableElements.length > 0 ? (
                <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 gap-2">
                  {availableElements.map((element) => (
                    <button
                      key={element}
                      type="button"
                      onClick={() => toggleDeviationElement(element)}
                      disabled={loadingElements}
                      className={`px-3 py-2 rounded-lg border-2 font-mono font-semibold transition-all ${
                        deviationElements.includes(element)
                          ? "border-primary-500 bg-primary-50 text-primary-700"
                          : "border-dark-200 bg-white text-dark-600 hover:border-dark-300"
                      } ${
                        loadingElements
                          ? "opacity-50 cursor-not-allowed"
                          : "cursor-pointer"
                      }`}
                    >
                      {element}
                    </button>
                  ))}
                </div>
              ) : !loadingElements ? (
                <p className="text-sm text-dark-500">
                  No elements available for this grade
                </p>
              ) : null}
            </div>
          )}

          {/* Deviation Percentage */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              type="number"
              label="Deviation Percentage (%)"
              value={deviationPercentage}
              onChange={(e) => setDeviationPercentage(Number(e.target.value))}
              min={0}
              max={100}
              step={0.1}
              required
              helpText="Percentage deviation to apply to selected elements"
            />
          </div>

          {/* Generate Button */}
          <Button
            onClick={handleGenerate}
            loading={generating}
            disabled={
              !opcStatus?.connected ||
              !selectedGrade ||
              deviationElements.length === 0 ||
              loadingElements
            }
            className="w-full md:w-auto"
          >
            {buttonText}
          </Button>

          {/* OPC Connection Warning */}
          {!opcStatus?.connected && (
            <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-800">
                <span className="font-semibold">OPC Server Not Connected:</span>{" "}
                Please connect to the OPC server to generate synthetic readings.
              </p>
            </div>
          )}

          {/* Info */}
          {deviationElements.length > 0 && opcStatus?.connected && (
            <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm text-blue-800">
                <span className="font-semibold">Selected elements:</span>{" "}
                {deviationElements.join(", ")} will be deviated by ±
                {deviationPercentage}%
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

export default SyntheticGenerator;
