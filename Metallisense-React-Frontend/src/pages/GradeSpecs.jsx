import React, { useState, useEffect } from "react";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import Modal from "../components/common/Modal";
import Input from "../components/common/Input";
import Badge from "../components/common/Badge";
import { Plus, Edit, Trash2, Search, Eye } from "lucide-react";
import {
  getAllGradeSpecs,
  createGradeSpec,
  updateGradeSpec,
  deleteGradeSpec,
} from "../services/gradeSpecService";
import toast from "react-hot-toast";
import { formatPercentage } from "../utils/formatters";

const GradeSpecs = () => {
  const [gradeSpecs, setGradeSpecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingGrade, setEditingGrade] = useState(null);
  const [selectedGrade, setSelectedGrade] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    grade: "",
    standard: "",
    description: "",
    composition_ranges: {
      Fe: [0, 0],
      C: [0, 0],
      Si: [0, 0],
      Mn: [0, 0],
      P: [0, 0],
      S: [0, 0],
    },
    physical_properties: {
      tensile_strength_mpa: [0, 0],
      yield_strength_mpa: [0, 0],
      elongation_percent: [0, 0],
    },
    typical_applications: [],
  });

  useEffect(() => {
    fetchGradeSpecs();
  }, []);

  const fetchGradeSpecs = async () => {
    setLoading(true);
    try {
      const response = await getAllGradeSpecs();
      setGradeSpecs(response.data.data?.data || []);
    } catch (error) {
      console.error("Failed to fetch grade specs:", error);
      toast.error("Failed to load grade specifications");
    } finally {
      setLoading(false);
    }
  };

  const filteredGrades = gradeSpecs.filter(
    (grade) =>
      grade.grade?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      grade.standard?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      grade.description?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleOpenModal = (grade = null) => {
    if (grade) {
      setEditingGrade(grade);
      setFormData({
        grade: grade.grade,
        standard: grade.standard || "",
        description: grade.description || "",
        composition_ranges: grade.composition_ranges || {
          Fe: [0, 0],
          C: [0, 0],
          Si: [0, 0],
          Mn: [0, 0],
          P: [0, 0],
          S: [0, 0],
        },
        physical_properties: grade.physical_properties || {
          tensile_strength_mpa: [0, 0],
          yield_strength_mpa: [0, 0],
          elongation_percent: [0, 0],
        },
        typical_applications: grade.typical_applications || [],
      });
    } else {
      setEditingGrade(null);
      setFormData({
        grade: "",
        standard: "",
        description: "",
        composition_ranges: {
          Fe: [0, 0],
          C: [0, 0],
          Si: [0, 0],
          Mn: [0, 0],
          P: [0, 0],
          S: [0, 0],
        },
        physical_properties: {
          tensile_strength_mpa: [0, 0],
          yield_strength_mpa: [0, 0],
          elongation_percent: [0, 0],
        },
        typical_applications: [],
      });
    }
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setEditingGrade(null);
  };

  const handleViewGrade = (grade) => {
    setSelectedGrade(grade);
    setViewModalOpen(true);
  };

  const handleCompositionChange = (element, index, value) => {
    setFormData({
      ...formData,
      composition_ranges: {
        ...formData.composition_ranges,
        [element]: formData.composition_ranges[element].map((v, i) =>
          i === index ? parseFloat(value) || 0 : v
        ),
      },
    });
  };

  const handlePhysicalPropertyChange = (property, index, value) => {
    setFormData({
      ...formData,
      physical_properties: {
        ...formData.physical_properties,
        [property]: formData.physical_properties[property].map((v, i) =>
          i === index ? parseFloat(value) || 0 : v
        ),
      },
    });
  };

  const handleApplicationsChange = (value) => {
    const apps = value
      .split(",")
      .map((app) => app.trim())
      .filter(Boolean);
    setFormData({ ...formData, typical_applications: apps });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Validate ranges
    const elements = Object.keys(formData.composition_ranges);
    for (const el of elements) {
      const [min, max] = formData.composition_ranges[el];
      if (min >= max) {
        toast.error(`Invalid range for ${el}: min must be less than max`);
        return;
      }
    }

    setSubmitting(true);
    try {
      if (editingGrade) {
        await updateGradeSpec(editingGrade._id, formData);
        toast.success("Grade specification updated successfully");
      } else {
        await createGradeSpec(formData);
        toast.success("Grade specification created successfully");
      }
      handleCloseModal();
      fetchGradeSpecs();
    } catch (error) {
      console.error("Failed to save grade spec:", error);
      toast.error(
        error.response?.data?.message || "Failed to save grade specification"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    if (
      !window.confirm(
        "Are you sure you want to delete this grade specification?"
      )
    )
      return;

    try {
      await deleteGradeSpec(id);
      toast.success("Grade specification deleted successfully");
      fetchGradeSpecs();
    } catch (error) {
      console.error("Failed to delete grade spec:", error);
      toast.error("Failed to delete grade specification");
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-dark-900">
            Grade Specifications
          </h1>
          <p className="text-dark-600 mt-1">
            Manage metal grade standards and composition ranges
          </p>
        </div>
        <Button onClick={() => handleOpenModal()}>
          <Plus size={18} className="inline mr-2" />
          Add New Grade
        </Button>
      </div>

      {/* Search */}
      <Card>
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 transform -translate-y-1/2 text-dark-400"
            size={20}
          />
          <input
            type="text"
            placeholder="Search by grade name, standard, or description..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-dark-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </Card>

      {/* Table */}
      <Card>
        {loading ? (
          <div className="text-center py-12 text-dark-500">
            Loading grade specifications...
          </div>
        ) : filteredGrades.length === 0 ? (
          <div className="text-center py-12 text-dark-500">
            {searchTerm
              ? "No grade specifications found matching your search"
              : "No grade specifications yet. Create one to get started."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-dark-200">
              <thead className="bg-dark-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-dark-700 uppercase tracking-wider">
                    Grade
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-dark-700 uppercase tracking-wider">
                    Standard
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-dark-700 uppercase tracking-wider">
                    Description
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-dark-700 uppercase tracking-wider">
                    Fe Range
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-dark-700 uppercase tracking-wider">
                    C Range
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-dark-700 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-dark-200">
                {filteredGrades.map((spec) => (
                  <tr key={spec._id} className="hover:bg-dark-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="font-mono font-bold text-dark-900">
                        {spec.grade}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-dark-600">
                      {spec.standard}
                    </td>
                    <td className="px-6 py-4 text-sm text-dark-600">
                      {spec.description}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-dark-900">
                      {spec.composition_ranges?.Fe
                        ? `${spec.composition_ranges.Fe[0]}-${spec.composition_ranges.Fe[1]}%`
                        : "N/A"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-dark-900">
                      {spec.composition_ranges?.C
                        ? `${spec.composition_ranges.C[0]}-${spec.composition_ranges.C[1]}%`
                        : "N/A"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleViewGrade(spec)}
                          className="text-blue-600 hover:text-blue-800"
                          title="View Details"
                        >
                          <Eye size={18} />
                        </button>
                        <button
                          onClick={() => handleOpenModal(spec)}
                          className="text-primary-600 hover:text-primary-800"
                          title="Edit"
                        >
                          <Edit size={18} />
                        </button>
                        <button
                          onClick={() => handleDelete(spec._id)}
                          className="text-red-600 hover:text-red-800"
                          title="Delete"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={handleCloseModal}
        title={
          editingGrade
            ? "Edit Grade Specification"
            : "Add New Grade Specification"
        }
        size="2xl"
      >
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Grade Name *"
              value={formData.grade}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  grade: e.target.value.toUpperCase(),
                })
              }
              placeholder="e.g., SG-IRON"
              required
              disabled={editingGrade !== null}
            />
            <Input
              label="Standard *"
              value={formData.standard}
              onChange={(e) =>
                setFormData({ ...formData, standard: e.target.value })
              }
              placeholder="e.g., IS 1865:1991"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-dark-700 mb-2">
              Description *
            </label>
            <textarea
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              rows={2}
              placeholder="Brief description of the grade"
              className="w-full px-3 py-2 border border-dark-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              required
            />
          </div>

          {/* Composition Ranges */}
          <div>
            <h3 className="text-lg font-semibold text-dark-900 mb-3">
              Composition Ranges (%) *
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {Object.keys(formData.composition_ranges).map((element) => (
                <div key={element} className="flex items-center gap-2">
                  <label className="font-mono font-bold text-dark-700 w-8">
                    {element}:
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Min"
                    value={formData.composition_ranges[element][0]}
                    onChange={(e) =>
                      handleCompositionChange(element, 0, e.target.value)
                    }
                    containerClassName="flex-1 mb-0"
                    required
                  />
                  <span className="text-dark-500">-</span>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Max"
                    value={formData.composition_ranges[element][1]}
                    onChange={(e) =>
                      handleCompositionChange(element, 1, e.target.value)
                    }
                    containerClassName="flex-1 mb-0"
                    required
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Physical Properties */}
          <div>
            <h3 className="text-lg font-semibold text-dark-900 mb-3">
              Physical Properties (Optional)
            </h3>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <label className="text-sm text-dark-700 w-48">
                  Tensile Strength (MPa):
                </label>
                <Input
                  type="number"
                  step="1"
                  placeholder="Min"
                  value={formData.physical_properties.tensile_strength_mpa[0]}
                  onChange={(e) =>
                    handlePhysicalPropertyChange(
                      "tensile_strength_mpa",
                      0,
                      e.target.value
                    )
                  }
                  containerClassName="flex-1 mb-0"
                />
                <span className="text-dark-500">-</span>
                <Input
                  type="number"
                  step="1"
                  placeholder="Max"
                  value={formData.physical_properties.tensile_strength_mpa[1]}
                  onChange={(e) =>
                    handlePhysicalPropertyChange(
                      "tensile_strength_mpa",
                      1,
                      e.target.value
                    )
                  }
                  containerClassName="flex-1 mb-0"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-dark-700 w-48">
                  Yield Strength (MPa):
                </label>
                <Input
                  type="number"
                  step="1"
                  placeholder="Min"
                  value={formData.physical_properties.yield_strength_mpa[0]}
                  onChange={(e) =>
                    handlePhysicalPropertyChange(
                      "yield_strength_mpa",
                      0,
                      e.target.value
                    )
                  }
                  containerClassName="flex-1 mb-0"
                />
                <span className="text-dark-500">-</span>
                <Input
                  type="number"
                  step="1"
                  placeholder="Max"
                  value={formData.physical_properties.yield_strength_mpa[1]}
                  onChange={(e) =>
                    handlePhysicalPropertyChange(
                      "yield_strength_mpa",
                      1,
                      e.target.value
                    )
                  }
                  containerClassName="flex-1 mb-0"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-dark-700 w-48">
                  Elongation (%):
                </label>
                <Input
                  type="number"
                  step="0.1"
                  placeholder="Min"
                  value={formData.physical_properties.elongation_percent[0]}
                  onChange={(e) =>
                    handlePhysicalPropertyChange(
                      "elongation_percent",
                      0,
                      e.target.value
                    )
                  }
                  containerClassName="flex-1 mb-0"
                />
                <span className="text-dark-500">-</span>
                <Input
                  type="number"
                  step="0.1"
                  placeholder="Max"
                  value={formData.physical_properties.elongation_percent[1]}
                  onChange={(e) =>
                    handlePhysicalPropertyChange(
                      "elongation_percent",
                      1,
                      e.target.value
                    )
                  }
                  containerClassName="flex-1 mb-0"
                />
              </div>
            </div>
          </div>

          {/* Typical Applications */}
          <div>
            <label className="block text-sm font-medium text-dark-700 mb-2">
              Typical Applications (comma-separated)
            </label>
            <textarea
              value={formData.typical_applications.join(", ")}
              onChange={(e) => handleApplicationsChange(e.target.value)}
              rows={2}
              placeholder="e.g., Automotive components, Pipe fittings, Machinery parts"
              className="w-full px-3 py-2 border border-dark-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t border-dark-200">
            <Button
              variant="secondary"
              onClick={handleCloseModal}
              type="button"
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {editingGrade ? "Update" : "Create"} Grade Specification
            </Button>
          </div>
        </form>
      </Modal>

      {/* View Details Modal */}
      <Modal
        isOpen={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        title="Grade Specification Details"
        size="xl"
      >
        {selectedGrade && (
          <div className="space-y-6">
            {/* Basic Info */}
            <div className="grid grid-cols-2 gap-4 p-4 bg-dark-50 rounded-lg">
              <div>
                <p className="text-sm text-dark-600">Grade</p>
                <p className="text-lg font-bold font-mono text-dark-900">
                  {selectedGrade.grade}
                </p>
              </div>
              <div>
                <p className="text-sm text-dark-600">Standard</p>
                <p className="text-lg font-semibold text-dark-900">
                  {selectedGrade.standard}
                </p>
              </div>
              <div className="col-span-2">
                <p className="text-sm text-dark-600">Description</p>
                <p className="text-dark-900">{selectedGrade.description}</p>
              </div>
            </div>

            {/* Composition Ranges */}
            <div>
              <h3 className="text-lg font-semibold text-dark-900 mb-3">
                Composition Ranges
              </h3>
              <div className="overflow-hidden border border-dark-200 rounded-lg">
                <table className="min-w-full divide-y divide-dark-200">
                  <thead className="bg-dark-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-dark-700 uppercase">
                        Element
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-dark-700 uppercase">
                        Min %
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-dark-700 uppercase">
                        Max %
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-dark-700 uppercase">
                        Range
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-200">
                    {Object.entries(selectedGrade.composition_ranges || {}).map(
                      ([element, range]) => (
                        <tr key={element}>
                          <td className="px-4 py-2 font-mono font-bold text-dark-900">
                            {element}
                          </td>
                          <td className="px-4 py-2 text-dark-700">
                            {range[0]}%
                          </td>
                          <td className="px-4 py-2 text-dark-700">
                            {range[1]}%
                          </td>
                          <td className="px-4 py-2 font-semibold text-primary-600">
                            {range[0]}-{range[1]}%
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Physical Properties */}
            {selectedGrade.physical_properties && (
              <div>
                <h3 className="text-lg font-semibold text-dark-900 mb-3">
                  Physical Properties
                </h3>
                <div className="grid gap-3">
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm text-blue-700">Tensile Strength</p>
                    <p className="text-lg font-bold text-blue-900">
                      {
                        selectedGrade.physical_properties
                          .tensile_strength_mpa[0]
                      }
                      -
                      {
                        selectedGrade.physical_properties
                          .tensile_strength_mpa[1]
                      }{" "}
                      MPa
                    </p>
                  </div>
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-sm text-green-700">Yield Strength</p>
                    <p className="text-lg font-bold text-green-900">
                      {selectedGrade.physical_properties.yield_strength_mpa[0]}-
                      {selectedGrade.physical_properties.yield_strength_mpa[1]}{" "}
                      MPa
                    </p>
                  </div>
                  <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg">
                    <p className="text-sm text-purple-700">Elongation</p>
                    <p className="text-lg font-bold text-purple-900">
                      {selectedGrade.physical_properties.elongation_percent[0]}-
                      {selectedGrade.physical_properties.elongation_percent[1]}%
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Applications */}
            {selectedGrade.typical_applications &&
              selectedGrade.typical_applications.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold text-dark-900 mb-3">
                    Typical Applications
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedGrade.typical_applications.map((app, index) => (
                      <Badge key={index} variant="info">
                        {app}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

            {/* Timestamps */}
            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-dark-200 text-xs text-dark-500">
              <div>
                <p>
                  Created: {new Date(selectedGrade.createdAt).toLocaleString()}
                </p>
              </div>
              <div>
                <p>
                  Updated: {new Date(selectedGrade.updatedAt).toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default GradeSpecs;
