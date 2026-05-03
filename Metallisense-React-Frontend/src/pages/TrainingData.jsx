import React, { useState, useEffect } from "react";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import Modal from "../components/common/Modal";
import Input from "../components/common/Input";
import Badge from "../components/common/Badge";
import Select from "../components/common/Select";
import {
  Plus,
  Edit,
  Trash2,
  Eye,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import {
  getPaginatedTrainingData,
  createTrainingData,
  updateTrainingData,
  deleteTrainingData,
} from "../services/trainingDataService";
import { getAllGradeSpecs } from "../services/gradeSpecService";
import toast from "react-hot-toast";

const TrainingData = () => {
  // Pagination & Data
  const [trainingData, setTrainingData] = useState([]);
  const [pagination, setPagination] = useState({});
  const [loading, setLoading] = useState(false);
  const [availableGrades, setAvailableGrades] = useState([]);

  // Filters & Sorting
  const [currentPage, setCurrentPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [gradeFilter, setGradeFilter] = useState("");
  const [sampleTypeFilter, setSampleTypeFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [sortField, setSortField] = useState("-createdAt");

  // Modals
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingSample, setEditingSample] = useState(null);
  const [selectedSample, setSelectedSample] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    grade: "",
    Fe: 0,
    C: 0,
    Si: 0,
    Mn: 0,
    P: 0,
    S: 0,
    deviated: 0,
    severity: "none",
    sample_type: "normal",
  });

  // Fetch available grades
  useEffect(() => {
    const fetchGrades = async () => {
      try {
        const response = await getAllGradeSpecs();
        console.log("Grades response:", response.data);
        const grades = response.data.data?.data || [];
        console.log("Extracted grades:", grades);
        setAvailableGrades(grades);
      } catch (error) {
        console.error("Error fetching grades:", error);
        toast.error("Failed to load grades");
      }
    };
    fetchGrades();
  }, []);

  // Fetch paginated training data
  const fetchTrainingData = async () => {
    setLoading(true);
    try {
      const params = {
        page: currentPage,
        limit: limit,
        sort: sortField,
      };

      // Add filters only if they're set
      if (gradeFilter) params.grade = gradeFilter;
      if (sampleTypeFilter) params.sample_type = sampleTypeFilter;
      if (severityFilter) params.severity = severityFilter;

      console.log("Fetching paginated training data with params:", params);

      const response = await getPaginatedTrainingData(params);

      console.log("API Response:", response.data);

      if (response.data.status === "success") {
        const fetchedData = response.data.data?.trainingData || [];
        setTrainingData(fetchedData);
        setPagination(response.data.pagination);
        console.log(
          `Loaded ${fetchedData.length} samples. Total: ${response.data.pagination?.totalDocuments}`
        );
      } else {
        setTrainingData([]);
        setPagination({});
      }
    } catch (error) {
      console.error("Error fetching training data:", error);
      toast.error("Failed to load training data");
      setTrainingData([]);
      setPagination({});
    } finally {
      setLoading(false);
    }
  };

  // Fetch data when filters/page changes
  useEffect(() => {
    fetchTrainingData();
  }, [
    currentPage,
    limit,
    gradeFilter,
    sampleTypeFilter,
    severityFilter,
    sortField,
  ]);

  // Reset to page 1 when filters change
  const handleFilterChange = (setter) => (value) => {
    setCurrentPage(1);
    setter(value);
  };

  const handleCreate = () => {
    setEditingSample(null);
    setFormData({
      grade: "",
      Fe: 0,
      C: 0,
      Si: 0,
      Mn: 0,
      P: 0,
      S: 0,
      deviated: 0,
      severity: "none",
      sample_type: "normal",
    });
    setModalOpen(true);
  };

  const handleEdit = (sample) => {
    setEditingSample(sample);
    setFormData({
      grade: sample.grade,
      Fe: sample.Fe,
      C: sample.C,
      Si: sample.Si,
      Mn: sample.Mn,
      P: sample.P,
      S: sample.S,
      deviated: sample.deviated || 0,
      severity: sample.severity || "none",
      sample_type: sample.sample_type || "normal",
    });
    setModalOpen(true);
  };

  const handleView = (sample) => {
    setSelectedSample(sample);
    setViewModalOpen(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Are you sure you want to delete this sample?")) return;

    try {
      await deleteTrainingData(id);
      toast.success("Sample deleted successfully");
      fetchTrainingData();
    } catch (error) {
      console.error("Error deleting sample:", error);
      toast.error("Failed to delete sample");
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const payload = {
        ...formData,
        Fe: parseFloat(formData.Fe),
        C: parseFloat(formData.C),
        Si: parseFloat(formData.Si),
        Mn: parseFloat(formData.Mn),
        P: parseFloat(formData.P),
        S: parseFloat(formData.S),
        deviated: parseInt(formData.deviated),
      };

      if (editingSample) {
        await updateTrainingData(editingSample._id, payload);
        toast.success("Sample updated successfully");
      } else {
        await createTrainingData(payload);
        toast.success("Sample created successfully");
      }

      setModalOpen(false);
      fetchTrainingData();
    } catch (error) {
      console.error("Error saving sample:", error);
      toast.error(error.response?.data?.message || "Failed to save sample");
    } finally {
      setSubmitting(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const getSeverityBadge = (severity) => {
    const variants = {
      none: "default",
      mild: "warning",
      moderate: "warning",
      severe: "error",
    };
    return <Badge variant={variants[severity] || "default"}>{severity}</Badge>;
  };

  const getTypeBadge = (type) => {
    return (
      <Badge variant={type === "normal" ? "success" : "error"}>{type}</Badge>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-metal-900">
            Training Data Management
          </h1>
          <p className="text-metal-600 mt-2">
            {pagination.totalDocuments ? (
              <>
                Showing{" "}
                <span className="font-semibold text-primary-600">
                  {trainingData.length}
                </span>{" "}
                of{" "}
                <span className="font-semibold text-primary-600">
                  {pagination.totalDocuments.toLocaleString()}
                </span>{" "}
                samples
              </>
            ) : (
              "Manage AI training samples with advanced filtering and pagination"
            )}
          </p>
        </div>
        <Button onClick={handleCreate} icon={Plus}>
          Add Sample
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
          <Select
            label="Grade"
            value={gradeFilter}
            onChange={(e) => handleFilterChange(setGradeFilter)(e.target.value)}
            options={[
              { value: "", label: "All Grades" },
              ...availableGrades.map((grade) => ({
                value: grade.name || grade.grade,
                label: grade.name || grade.grade,
              })),
            ]}
          />

          <Select
            label="Sample Type"
            value={sampleTypeFilter}
            onChange={(e) =>
              handleFilterChange(setSampleTypeFilter)(e.target.value)
            }
            options={[
              { value: "", label: "All Types" },
              { value: "normal", label: "Normal" },
              { value: "deviated", label: "Deviated" },
            ]}
          />

          <Select
            label="Severity"
            value={severityFilter}
            onChange={(e) =>
              handleFilterChange(setSeverityFilter)(e.target.value)
            }
            options={[
              { value: "", label: "All Severities" },
              { value: "none", label: "None" },
              { value: "mild", label: "Mild" },
              { value: "moderate", label: "Moderate" },
              { value: "severe", label: "Severe" },
            ]}
          />

          <Select
            label="Sort By"
            value={sortField}
            onChange={(e) => setSortField(e.target.value)}
            options={[
              { value: "-createdAt", label: "Newest First" },
              { value: "createdAt", label: "Oldest First" },
              { value: "-Fe", label: "Fe (High to Low)" },
              { value: "Fe", label: "Fe (Low to High)" },
              { value: "-C", label: "C (High to Low)" },
              { value: "C", label: "C (Low to High)" },
              { value: "-Si", label: "Si (High to Low)" },
              { value: "Si", label: "Si (Low to High)" },
            ]}
          />

          <Select
            label="Per Page"
            value={limit}
            onChange={(e) =>
              handleFilterChange(setLimit)(parseInt(e.target.value))
            }
            options={[
              { value: 25, label: "25" },
              { value: 50, label: "50" },
              { value: 100, label: "100" },
            ]}
          />

          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={fetchTrainingData}
              icon={RefreshCw}
              className="w-full"
            >
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      {/* Pagination Info */}
      {pagination.totalPages && (
        <Card>
          <div className="flex justify-between items-center text-sm">
            <p className="text-metal-600">
              Page{" "}
              <span className="font-bold text-primary-600">
                {pagination.currentPage}
              </span>{" "}
              of{" "}
              <span className="font-bold text-primary-600">
                {pagination.totalPages?.toLocaleString()}
              </span>
            </p>
            <p className="text-metal-600">
              Total:{" "}
              <span className="font-bold text-primary-600">
                {pagination.totalDocuments?.toLocaleString()}
              </span>{" "}
              samples
            </p>
          </div>
        </Card>
      )}

      {/* Data Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b-2 border-metal-200">
              <tr>
                <th className="px-4 py-3 text-left text-metal-800 font-bold text-sm">
                  Grade
                </th>
                <th className="px-4 py-3 text-left text-metal-800 font-bold text-sm">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-metal-800 font-bold text-sm">
                  Severity
                </th>
                <th className="px-4 py-3 text-right text-metal-800 font-bold text-sm">
                  Fe %
                </th>
                <th className="px-4 py-3 text-right text-metal-800 font-bold text-sm">
                  C %
                </th>
                <th className="px-4 py-3 text-right text-metal-800 font-bold text-sm">
                  Si %
                </th>
                <th className="px-4 py-3 text-right text-metal-800 font-bold text-sm">
                  Mn %
                </th>
                <th className="px-4 py-3 text-right text-metal-800 font-bold text-sm">
                  P %
                </th>
                <th className="px-4 py-3 text-right text-metal-800 font-bold text-sm">
                  S %
                </th>
                <th className="px-4 py-3 text-center text-metal-800 font-bold text-sm">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-metal-100">
              {loading ? (
                <tr>
                  <td colSpan="10" className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center justify-center space-y-3">
                      <RefreshCw className="w-8 h-8 animate-spin text-primary-500" />
                      <span className="text-metal-600 font-medium">
                        Loading training data...
                      </span>
                    </div>
                  </td>
                </tr>
              ) : trainingData.length === 0 ? (
                <tr>
                  <td colSpan="10" className="px-4 py-12 text-center">
                    <p className="text-metal-600 font-medium">
                      No training data found
                    </p>
                    <p className="text-metal-500 text-sm mt-1">
                      Try adjusting your filters
                    </p>
                  </td>
                </tr>
              ) : (
                trainingData.map((sample) => (
                  <tr
                    key={sample._id}
                    className="hover:bg-metal-50 transition-colors"
                  >
                    <td className="px-4 py-3 text-metal-900 font-semibold">
                      {sample.grade}
                    </td>
                    <td className="px-4 py-3">
                      {getTypeBadge(sample.sample_type)}
                    </td>
                    <td className="px-4 py-3">
                      {getSeverityBadge(sample.severity)}
                    </td>
                    <td className="px-4 py-3 text-right text-metal-700 font-mono font-medium">
                      {sample.Fe.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right text-metal-700 font-mono font-medium">
                      {sample.C.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right text-metal-700 font-mono font-medium">
                      {sample.Si.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right text-metal-700 font-mono font-medium">
                      {sample.Mn.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right text-metal-700 font-mono font-medium">
                      {sample.P.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right text-metal-700 font-mono font-medium">
                      {sample.S.toFixed(3)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-center space-x-2">
                        <button
                          onClick={() => handleView(sample)}
                          className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 p-2 rounded-lg transition-all"
                          title="View Details"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleEdit(sample)}
                          className="text-amber-600 hover:text-amber-700 hover:bg-amber-50 p-2 rounded-lg transition-all"
                          title="Edit Sample"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(sample._id)}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 p-2 rounded-lg transition-all"
                          title="Delete Sample"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination Controls */}
      {pagination.totalPages && pagination.totalPages > 1 && (
        <Card>
          <div className="flex justify-center items-center gap-4">
            <Button
              onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
              disabled={!pagination.hasPrevPage}
              variant="secondary"
              icon={ChevronLeft}
            >
              Previous
            </Button>

            <div className="px-4 py-2 bg-metal-50 rounded-lg border border-metal-200">
              <span className="text-metal-700 font-medium">
                Page{" "}
                <span className="font-bold text-primary-600">
                  {currentPage}
                </span>{" "}
                of{" "}
                <span className="font-bold text-primary-600">
                  {pagination.totalPages?.toLocaleString()}
                </span>
              </span>
            </div>

            <Button
              onClick={() => setCurrentPage((prev) => prev + 1)}
              disabled={!pagination.hasNextPage}
              variant="secondary"
              icon={ChevronRight}
            >
              Next
            </Button>
          </div>
        </Card>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingSample ? "Edit Training Sample" : "Add Training Sample"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Select
            label="Grade *"
            name="grade"
            value={formData.grade}
            onChange={handleInputChange}
            required
            options={[
              { value: "", label: "Select Grade" },
              ...availableGrades.map((grade) => ({
                value: grade.name || grade.grade,
                label: grade.name || grade.grade,
              })),
            ]}
          />

          <div className="grid grid-cols-2 gap-4">
            {["Fe", "C", "Si", "Mn", "P", "S"].map((element) => (
              <Input
                key={element}
                label={`${element} (%) *`}
                name={element}
                type="number"
                step="0.001"
                value={formData[element]}
                onChange={handleInputChange}
                required
              />
            ))}
          </div>

          <Select
            label="Sample Type *"
            name="sample_type"
            value={formData.sample_type}
            onChange={handleInputChange}
            required
            options={[
              { value: "normal", label: "Normal" },
              { value: "deviated", label: "Deviated" },
            ]}
          />

          <Select
            label="Severity *"
            name="severity"
            value={formData.severity}
            onChange={handleInputChange}
            required
            options={[
              { value: "none", label: "None" },
              { value: "mild", label: "Mild" },
              { value: "moderate", label: "Moderate" },
              { value: "severe", label: "Severe" },
            ]}
          />

          <Input
            label="Deviated (0 or 1)"
            name="deviated"
            type="number"
            min="0"
            max="1"
            value={formData.deviated}
            onChange={handleInputChange}
          />

          <div className="flex justify-end space-x-3 pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving..." : editingSample ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* View Modal */}
      <Modal
        isOpen={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        title="Sample Details"
      >
        {selectedSample && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-metal-600 mb-1">
                  Grade
                </p>
                <p className="text-metal-900 font-bold">
                  {selectedSample.grade}
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold text-metal-600 mb-1">
                  Type
                </p>
                {getTypeBadge(selectedSample.sample_type)}
              </div>
              <div>
                <p className="text-sm font-semibold text-metal-600 mb-1">
                  Severity
                </p>
                {getSeverityBadge(selectedSample.severity)}
              </div>
              <div>
                <p className="text-sm font-semibold text-metal-600 mb-1">
                  Deviated
                </p>
                <p className="text-metal-900 font-bold">
                  {selectedSample.deviated ? "Yes" : "No"}
                </p>
              </div>
            </div>

            <div className="border-t border-metal-200 pt-4">
              <p className="text-primary-600 font-bold mb-3">
                Chemical Composition
              </p>
              <div className="grid grid-cols-3 gap-4">
                {["Fe", "C", "Si", "Mn", "P", "S"].map((element) => (
                  <div key={element} className="bg-metal-50 p-3 rounded-lg">
                    <p className="text-metal-600 text-xs font-semibold mb-1">
                      {element}
                    </p>
                    <p className="text-metal-900 font-mono font-bold">
                      {selectedSample[element].toFixed(3)}%
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {selectedSample.createdAt && (
              <div className="border-t border-metal-200 pt-4">
                <p className="text-sm font-semibold text-metal-600 mb-1">
                  Created At
                </p>
                <p className="text-metal-900">
                  {new Date(selectedSample.createdAt).toLocaleString()}
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default TrainingData;
