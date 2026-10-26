import React, { useState } from "react";
import { Search, Sparkles } from "lucide-react";
import Card from "../components/common/Card";
import Button from "../components/common/Button";
import Input from "../components/common/Input";
import Select from "../components/common/Select";
import Badge from "../components/common/Badge";
import { semanticSearch } from "../services/semanticSearchService";
import toast from "react-hot-toast";

// Semantic Search over training data / grade specs, powered by Actian
// VectorAI DB (PEC Hacks 4.0 x Actian VectorAI DB submission).
export default function SemanticSearch() {
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("training_data");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setSearched(true);
    try {
      const response = await semanticSearch(query, collection, 8);
      setResults(response.data.results || []);
    } catch (error) {
      console.error("Semantic search failed:", error);
      toast.error(
        error.response?.data?.detail ||
          "Semantic search service unavailable. Is MetalliSense_VectorSearch running on port 8002?"
      );
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Sparkles className="text-emerald-600" size={28} />
        <div>
          <h1 className="text-2xl font-bold text-metal-900">Semantic Search</h1>
          <p className="text-metal-500 text-sm">
            Search readings and grade specs by meaning — powered by Actian VectorAI DB
          </p>
        </div>
      </div>

      <Card>
        <form onSubmit={handleSearch} className="flex flex-col md:flex-row gap-3">
          <div className="flex-1">
            <Input
              placeholder='e.g. "high carbon reading that looks out of spec"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              containerClassName="mb-0"
            />
          </div>
          <Select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            className="md:w-48"
            options={[
              { value: "training_data", label: "Training Data" },
              { value: "grades", label: "Grade Specs" },
            ]}
          />
          <Button type="submit" loading={loading} disabled={!query.trim()}>
            <Search size={18} className="mr-2" />
            Search
          </Button>
        </form>
      </Card>

      {searched && !loading && results.length === 0 && (
        <Card>
          <p className="text-metal-500 text-center py-8">
            No results — or the search service isn't reachable. Check that
            MetalliSense_VectorSearch is running and connected to VectorAI DB.
          </p>
        </Card>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          {results.map((r, i) => (
            <Card key={i}>
              <div className="flex items-start justify-between gap-4">
                <p className="text-metal-800">{r.text}</p>
                <Badge variant={r.score > 0.7 ? "success" : "default"}>
                  {(r.score * 100).toFixed(1)}% match
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
