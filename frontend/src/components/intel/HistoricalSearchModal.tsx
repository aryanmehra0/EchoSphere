"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Search,
  History,
  Copy,
  Check,
  Download,
  AlertCircle,
  ChevronRight,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  searchHistoricalIncidents,
  type HistoricalIncidentResult,
} from "@/lib/delta-socket";

export function HistoricalSearchModal() {
  const { historicalSearchOpen, setHistoricalSearchOpen } = useIncident();

  if (!historicalSearchOpen) return null;
  return (
    <HistoricalSearchDialog
      open={historicalSearchOpen}
      onOpenChange={setHistoricalSearchOpen}
    />
  );
}

const PRESET_QUERIES = [
  "Redis memory saturation & key eviction",
  "Postgres connection pool exhaustion",
  "Auth TLS certificate expiry 503",
  "Kafka partition consumer lag",
];

function HistoricalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HistoricalIncidentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedIncident, setSelectedIncident] = useState<HistoricalIncidentResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [, startTransition] = useTransition();

  const handleSearch = async (searchQuery: string) => {
    const q = searchQuery.trim();
    if (!q) {
      setResults([]);
      setHasSearched(false);
      return;
    }

    setLoading(true);
    setHasSearched(true);
    try {
      const items = await searchHistoricalIncidents(q, 6, 0.25);
      startTransition(() => {
        setResults(items);
      });
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!query) return;
    const timer = setTimeout(() => {
      handleSearch(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleDownload = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0 gap-0 border-line bg-panel text-ink shadow-2xl overflow-hidden">
        {/* Header */}
        <DialogHeader className="p-4 border-b border-line bg-raised/50 flex flex-row items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-sm border border-line bg-sunken text-ink-2">
              <History size={16} strokeWidth={2} />
            </span>
            <div>
              <DialogTitle className="text-base font-semibold tracking-tight text-ink flex items-center gap-2">
                Historical Incident RAG Search
                <Badge variant="outline" className="text-3xs font-mono py-0 px-1.5 border-line text-ink-3">
                  Qdrant Vector DB
                </Badge>
              </DialogTitle>
              <p className="text-2xs text-ink-4">
                Cross-incident semantic precedent retrieval across archived postmortems
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* Search input bar */}
        <div className="p-4 border-b border-line bg-panel shrink-0 space-y-3">
          <div className="relative flex items-center">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4" size={16} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search past incidents, error patterns, symptoms, or runbooks... (e.g. redis memory saturation)"
              className="w-full pl-10 pr-10 py-2.5 bg-sunken border border-line rounded-sm text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-ink-3 font-sans transition-colors"
              autoFocus
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink p-0.5 rounded transition-colors"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Preset quick queries */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-3xs font-mono text-ink-4 uppercase tracking-wider">Precedents:</span>
            {PRESET_QUERIES.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setQuery(preset)}
                className="px-2 py-0.5 rounded text-2xs bg-sunken border border-line text-ink-3 hover:text-ink hover:border-ink-4 transition-colors font-sans"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        {/* Content Body: Split view or List view */}
        <div className="flex-1 overflow-y-auto min-h-[300px] p-4">
          {selectedIncident ? (
            /* Detailed Postmortem View */
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <button
                  type="button"
                  onClick={() => setSelectedIncident(null)}
                  className="flex items-center gap-1 text-2xs text-ink-3 hover:text-ink font-mono uppercase tracking-wider transition-colors"
                >
                  <ChevronRight size={14} className="rotate-180" /> Back to search results
                </button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    icon={copied ? <Check size={12} className="text-live" /> : <Copy size={12} />}
                    onClick={() => handleCopy(selectedIncident.markdown)}
                  >
                    {copied ? "Copied" : "Copy Markdown"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Download size={12} />}
                    onClick={() =>
                      handleDownload(
                        selectedIncident.markdown,
                        `postmortem-${selectedIncident.archiveId}.md`,
                      )
                    }
                  >
                    Download
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono text-2xs border-line">
                    {selectedIncident.archiveId}
                  </Badge>
                  <Badge variant="secondary" className="font-mono text-2xs">
                    Channel: {selectedIncident.channel}
                  </Badge>
                  <Badge
                    className="font-mono text-2xs bg-live/15 text-live border border-live/30"
                  >
                    {Math.round(selectedIncident.score * 100)}% Similarity
                  </Badge>
                </div>
                <h3 className="text-lg font-semibold text-ink">{selectedIncident.title}</h3>
                <p className="text-sm text-ink-2 bg-sunken/60 p-3 rounded border border-line">
                  {selectedIncident.summary}
                </p>
              </div>

              <div className="mt-4">
                <h4 className="text-xs font-mono uppercase tracking-wider text-ink-3 mb-2">
                  Archived Post-Mortem Report
                </h4>
                <pre className="p-4 rounded bg-sunken border border-line text-xs font-mono text-ink-2 overflow-x-auto whitespace-pre-wrap max-h-[400px]">
                  {selectedIncident.markdown}
                </pre>
              </div>
            </div>
          ) : (
            /* Results List */
            <div className="space-y-3">
              {loading && (
                <div className="py-12 flex flex-col items-center justify-center text-ink-4 gap-2">
                  <div className="h-5 w-5 border-2 border-line border-t-ink animate-spin rounded-full" />
                  <span className="text-xs font-mono">Querying dense semantic vector store...</span>
                </div>
              )}

              {!loading && hasSearched && results.length === 0 && (
                <div className="py-12 flex flex-col items-center justify-center text-center">
                  <AlertCircle size={28} className="text-ink-4 mb-2" />
                  <p className="text-sm font-semibold text-ink">No historical precedents found</p>
                  <p className="text-xs text-ink-4 max-w-sm mt-1">
                    No past incident postmortems matched the semantic query with similarity &gt; 25%.
                  </p>
                </div>
              )}

              {!loading && !hasSearched && (
                <div className="py-12 flex flex-col items-center justify-center text-center">
                  <Sparkles size={28} className="text-ink-4 mb-2" />
                  <p className="text-sm font-semibold text-ink">Search Historical Incident Memory</p>
                  <p className="text-xs text-ink-4 max-w-md mt-1">
                    Query resolved Sev-1 incidents, past postmortems, and telemetry investigations.
                    Attribution is strictly maintained under Rule 1.
                  </p>
                </div>
              )}

              {!loading &&
                results.map((r) => {
                  const scorePct = Math.round(r.score * 100);
                  const isHighMatch = scorePct >= 65;

                  return (
                    <div
                      key={r.archiveId}
                      className="p-3.5 rounded-sm border border-line bg-raised/40 hover:bg-raised hover:border-ink-4/40 transition-colors cursor-pointer space-y-2 group"
                      onClick={() => setSelectedIncident(r)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-2xs text-ink-3 group-hover:text-ink font-semibold">
                            {r.archiveId}
                          </span>
                          <span className="text-3xs font-mono text-ink-4">[{r.channel}]</span>
                        </div>
                        <Badge
                          className={`font-mono text-2xs ${
                            isHighMatch
                              ? "bg-live/15 text-live border border-live/30"
                              : "bg-warning/15 text-warning border border-warning/30"
                          }`}
                        >
                          {scorePct}% Match
                        </Badge>
                      </div>

                      <div className="text-sm font-medium text-ink group-hover:text-ink">
                        {r.title}
                      </div>

                      <p className="text-xs text-ink-3 line-clamp-2 leading-relaxed">
                        {r.summary}
                      </p>

                      {r.keyClaims && r.keyClaims.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {r.keyClaims.slice(0, 3).map((claim, idx) => (
                            <span
                              key={idx}
                              className="text-3xs font-mono px-1.5 py-0.5 rounded bg-sunken border border-line text-ink-3"
                            >
                              {claim}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center justify-end pt-1">
                        <span className="text-2xs font-mono text-ink-4 group-hover:text-ink flex items-center gap-1 transition-colors">
                          Inspect Post-Mortem <ChevronRight size={12} />
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-line bg-raised/30 flex items-center justify-between text-3xs font-mono text-ink-4 shrink-0">
          <span className="flex items-center gap-1.5">
            <ShieldCheck size={12} className="text-ink-3" />
            Rule 1 Epistemic Guard Active: Echo uses historical precedents for correlation, never declaring root cause.
          </span>
          <span className="text-ink-4">ESC to close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
