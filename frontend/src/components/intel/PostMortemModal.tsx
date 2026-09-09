"use client";

import { useEffect, useState } from "react";
import {
  FileText,
  Download,
  Copy,
  Check,
  Printer,
  ShieldCheck,
  CheckCircle2,
  HelpCircle,
  Info,
  Clock,
  Activity,
  AlertCircle,
  Database,
  Lock,
} from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { fetchPostMortem } from "@/lib/delta-socket";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/badge";
import { Dot } from "@/components/ui/Signal";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  Claim,
  IncidentEntity,
  IncidentState,
  PostMortemResponse,
  Transcript,
} from "@/lib/types";

type ActiveTab = "preview" | "markdown" | "json";

export function PostMortemModal() {
  const { postMortemOpen, setPostMortemOpen } = useIncident();
  if (!postMortemOpen) return null;
  return <PostMortemDialog open={postMortemOpen} onOpenChange={setPostMortemOpen} />;
}

function PostMortemDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, now } = useIncident();
  const [tab, setTab] = useState<ActiveTab>("preview");
  const [data, setData] = useState<PostMortemResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    fetchPostMortem()
      .then((res) => {
        if (!active) return;
        setData(res ?? synthesizeFallback(state, now));
      })
      .catch(() => {
        if (!active) return;
        setData(synthesizeFallback(state, now));
      });
    return () => {
      active = false;
    };
  }, [state, now]);

  const loading = !data;

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const handleDownloadFile = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    window.print();
  };

  const incidentId = data?.postmortem.overview.incidentId || state.id || "INC-CURRENT";
  const markdownContent = data?.markdown || "";
  const jsonContent = data ? JSON.stringify(data.postmortem, null, 2) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[90vh] flex flex-col p-0 gap-0 overflow-hidden border-line-strong bg-raised shadow-2xl">
        {/* ── Modal Header ────────────────────────────────────────── */}
        <DialogHeader className="flex flex-row items-center justify-between border-b border-line px-5 py-3.5 bg-sunken/50 shrink-0 space-y-0">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-xs border border-line-strong bg-base text-ink">
              <FileText className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <DialogTitle className="text-sm font-semibold text-ink">
                  Incident Post-Mortem & SOC2 Audit Report
                </DialogTitle>
                <Badge variant="critical">
                  Sev {state.severity}
                </Badge>
                <span className="font-mono text-2xs text-ink-3">
                  {incidentId}
                </span>
              </div>
              <p className="text-2xs text-ink-4">
                Automated epistemic synthesis · Attributed facts · Cryptographic gate ledger
              </p>
            </div>
          </div>

          {/* Action Bar */}
          <div className="flex items-center gap-2 pr-6">
            <Button
              variant="secondary"
              size="sm"
              icon={<Printer className="h-3 w-3" />}
              onClick={handlePrint}
              title="Print or Save as PDF"
            >
              Print / PDF
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="h-3 w-3" />}
              onClick={() =>
                handleDownloadFile(
                  markdownContent,
                  `${incidentId.toLowerCase()}-postmortem.md`,
                  "text/markdown;charset=utf-8",
                )
              }
              title="Download GFM Markdown"
            >
              Export .md
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="h-3 w-3" />}
              onClick={() =>
                handleDownloadFile(
                  jsonContent,
                  `${incidentId.toLowerCase()}-soc2-audit.json`,
                  "application/json;charset=utf-8",
                )
              }
              title="Download SOC2 Audit JSON"
            >
              Export .json
            </Button>
          </div>
        </DialogHeader>

        {/* ── Subheader / Tabs & Disclaimer ────────────────────────── */}
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as ActiveTab)}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="border-b border-line bg-raised/80 px-5 pt-2 pb-0 shrink-0">
            <div className="flex items-center justify-between">
              {/* Tabs list */}
              <TabsList className="bg-transparent border-0 p-0 h-auto gap-2">
                <TabsTrigger
                  value="preview"
                  className="px-3 py-1.5 text-xs font-medium rounded-none border-b-2 border-transparent data-[state=active]:border-ink data-[state=active]:bg-transparent data-[state=active]:text-ink text-ink-3 hover:text-ink-2 cursor-pointer select-none"
                >
                  Executive Preview
                </TabsTrigger>
                <TabsTrigger
                  value="markdown"
                  className="px-3 py-1.5 text-xs font-medium rounded-none border-b-2 border-transparent data-[state=active]:border-ink data-[state=active]:bg-transparent data-[state=active]:text-ink text-ink-3 hover:text-ink-2 cursor-pointer select-none"
                >
                  GFM Markdown
                </TabsTrigger>
                <TabsTrigger
                  value="json"
                  className="px-3 py-1.5 text-xs font-medium rounded-none border-b-2 border-transparent data-[state=active]:border-ink data-[state=active]:bg-transparent data-[state=active]:text-ink text-ink-3 hover:text-ink-2 cursor-pointer select-none"
                >
                  SOC2 Audit JSON
                </TabsTrigger>
              </TabsList>

              {/* Copy Button for current tab */}
              {tab !== "preview" && (
                <div className="pb-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={copied ? <Check className="h-3 w-3 text-live" /> : <Copy className="h-3 w-3" />}
                    onClick={() => handleCopy(tab === "markdown" ? markdownContent : jsonContent)}
                  >
                    {copied ? "Copied!" : tab === "markdown" ? "Copy Markdown" : "Copy JSON"}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Epistemic Discipline Disclaimer (Rule 1) */}
          <div className="flex items-start gap-2.5 border-b border-line-faint bg-sunken/40 px-5 py-2 shrink-0">
            <ShieldCheck className="h-3.5 w-3.5 text-ink-3 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed text-ink-3 font-mono">
              <strong className="text-ink-2">Rule 1 Compliance Notice:</strong> EchoSphere operates as a non-causal recording secretary. Root cause determination is deferred to offline engineering review. Inferred claims are segregated from causal attribution.
            </p>
          </div>

          {/* ── Scrollable Tab Content ───────────────────────────────── */}
          <div className="flex-1 overflow-y-auto p-6 bg-base">
            {loading ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2">
                <Dot tone="neutral" pulse />
                <p className="text-xs text-ink-3">Synthesizing post-mortem and audit record…</p>
              </div>
            ) : !data ? null : (
              <>
                <TabsContent value="preview" className="mt-0 space-y-6">
                  {/* 1. Overview KPIs */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="surface-sunken rounded-sm p-3 border border-line-faint">
                      <span className="eyebrow block mb-1">Status / Phase</span>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Dot tone={data.postmortem.overview.status === "RESOLVED" ? "stable" : "warning"} />
                        <span className="text-sm font-semibold uppercase text-ink">
                          {data.postmortem.overview.phase}
                        </span>
                      </div>
                    </div>
                    <div className="surface-sunken rounded-sm p-3 border border-line-faint">
                      <span className="eyebrow block mb-1">Bridge Duration</span>
                      <div className="flex items-center gap-1.5 mt-1 text-sm font-mono font-semibold text-ink">
                        <Clock className="h-3.5 w-3.5 text-ink-3" />
                        <span>{data.postmortem.overview.duration}</span>
                      </div>
                    </div>
                    <div className="surface-sunken rounded-sm p-3 border border-line-faint">
                      <span className="eyebrow block mb-1">Peak Room Tension</span>
                      <div className="flex items-center gap-1.5 mt-1 text-sm font-mono font-semibold text-ink">
                        <Activity className="h-3.5 w-3.5 text-ink-3" />
                        <span>{(data.postmortem.overview.peakRti * 100).toFixed(0)}% RTI</span>
                      </div>
                    </div>
                    <div className="surface-sunken rounded-sm p-3 border border-line-faint">
                      <span className="eyebrow block mb-1">Time of Origin</span>
                      <span className="text-xs font-mono text-ink-2 block mt-1">
                        {data.postmortem.overview.startedAtFormatted}
                      </span>
                    </div>
                  </div>

                  {/* 2. Impacted Subsystems & Topology */}
                  <div>
                    <h3 className="eyebrow mb-2 flex items-center gap-1.5">
                      <Database className="h-3 w-3 text-ink-3" />
                      Monitored Subsystems & Topology ({data.postmortem.entities.length})
                    </h3>
                    {data.postmortem.entities.length === 0 ? (
                      <p className="text-xs text-ink-4 italic">No subsystems tracked.</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                        {data.postmortem.entities.map((e) => (
                          <div
                            key={e.id}
                            className="surface-sunken flex items-center justify-between rounded-sm border border-line-faint px-3 py-2"
                          >
                            <div className="min-w-0 pr-2">
                              <span className="block truncate text-xs font-medium text-ink">
                                {e.label}
                              </span>
                              <span className="font-mono text-[10px] text-ink-4">
                                {e.kind} · {e.id}
                              </span>
                            </div>
                            <Badge
                              variant={
                                e.status === "CRITICAL"
                                  ? "critical"
                                  : e.status === "DEGRADED"
                                    ? "warning"
                                    : "stable"
                              }
                            >
                              {e.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 3. Epistemic Evidence Ledger */}
                  <div>
                    <h3 className="eyebrow mb-2">Epistemic Evidence Ledger</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Confirmed Facts */}
                      <div className="surface-sunken rounded-sm border border-line-faint p-3.5 space-y-2">
                        <div className="flex items-center justify-between border-b border-line-faint pb-1.5">
                          <div className="flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5 text-live" />
                            <span className="text-xs font-medium text-ink">
                              Observed Facts (Telemetry)
                            </span>
                          </div>
                          <Badge variant="live">
                            {data.postmortem.epistemicClaims.observed.length}
                          </Badge>
                        </div>
                        {data.postmortem.epistemicClaims.observed.length === 0 ? (
                          <p className="text-[11px] text-ink-4 italic py-1">No confirmed telemetry claims recorded.</p>
                        ) : (
                          <ul className="space-y-2">
                            {data.postmortem.epistemicClaims.observed.map((c, i) => (
                              <li key={i} className="text-xs text-ink-2 leading-relaxed">
                                <span className="text-live font-medium">✓</span> &ldquo;{c.text}&rdquo;
                                <div className="mt-0.5 font-mono text-[10px] text-ink-4">
                                  {c.speakerName || c.speakerRole} · {Math.round((c.confidence || 1) * 100)}% conf · {c.formattedTime}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {/* Open Hypotheses */}
                      <div className="surface-sunken rounded-sm border border-line-faint p-3.5 space-y-2">
                        <div className="flex items-center justify-between border-b border-line-faint pb-1.5">
                          <div className="flex items-center gap-1.5">
                            <HelpCircle className="h-3.5 w-3.5 text-warning" />
                            <span className="text-xs font-medium text-ink">
                              Open Hypotheses (Unverified)
                            </span>
                          </div>
                          <Badge variant="warning">
                            {data.postmortem.epistemicClaims.hypothesis.length}
                          </Badge>
                        </div>
                        {data.postmortem.epistemicClaims.hypothesis.length === 0 ? (
                          <p className="text-[11px] text-ink-4 italic py-1">No open unproven hypotheses.</p>
                        ) : (
                          <ul className="space-y-2">
                            {data.postmortem.epistemicClaims.hypothesis.map((c, i) => (
                              <li key={i} className="text-xs text-ink-2 leading-relaxed">
                                <span className="text-warning font-medium">?</span> &ldquo;{c.text}&rdquo;
                                <div className="mt-0.5 font-mono text-[10px] text-ink-4">
                                  {c.speakerName || c.speakerRole} · {Math.round((c.confidence || 0.8) * 100)}% conf · {c.formattedTime}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {/* System Inferences */}
                      <div className="surface-sunken rounded-sm border border-line-faint p-3.5 space-y-2">
                        <div className="flex items-center justify-between border-b border-line-faint pb-1.5">
                          <div className="flex items-center gap-1.5">
                            <Info className="h-3.5 w-3.5 text-ink-3" />
                            <span className="text-xs font-medium text-ink">
                              Non-Causal AI Inferences
                            </span>
                          </div>
                          <Badge variant="neutral">
                            {data.postmortem.epistemicClaims.inferred.length}
                          </Badge>
                        </div>
                        {data.postmortem.epistemicClaims.inferred.length === 0 ? (
                          <p className="text-[11px] text-ink-4 italic py-1">No AI inferences active.</p>
                        ) : (
                          <ul className="space-y-2">
                            {data.postmortem.epistemicClaims.inferred.map((c, i) => (
                              <li key={i} className="text-xs text-ink-3 leading-relaxed">
                                <span className="text-ink-4 font-mono">ℹ</span> &ldquo;{c.text}&rdquo;
                                <div className="mt-0.5 font-mono text-[10px] text-ink-4">
                                  Entity: {c.entity || "general"} · {Math.round((c.confidence || 0.7) * 100)}% conf
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {/* Refuted / Stale */}
                      <div className="surface-sunken rounded-sm border border-line-faint p-3.5 space-y-2">
                        <div className="flex items-center justify-between border-b border-line-faint pb-1.5">
                          <div className="flex items-center gap-1.5">
                            <AlertCircle className="h-3.5 w-3.5 text-ink-4" />
                            <span className="text-xs font-medium text-ink">
                              Refuted or Superseded Claims
                            </span>
                          </div>
                          <Badge variant="outline">
                            {data.postmortem.epistemicClaims.refutedOrStale.length}
                          </Badge>
                        </div>
                        {data.postmortem.epistemicClaims.refutedOrStale.length === 0 ? (
                          <p className="text-[11px] text-ink-4 italic py-1">No claims refuted or marked stale.</p>
                        ) : (
                          <ul className="space-y-2">
                            {data.postmortem.epistemicClaims.refutedOrStale.map((c, i) => (
                              <li key={i} className="text-xs text-ink-4 line-through leading-relaxed">
                                &ldquo;{c.text}&rdquo;
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 4. Chronological Incident Timeline */}
                  <div>
                    <h3 className="eyebrow mb-2">Attributed Chronological Timeline ({data.postmortem.timeline.length})</h3>
                    {data.postmortem.timeline.length === 0 ? (
                      <p className="text-xs text-ink-4 italic">No timeline entries recorded.</p>
                    ) : (
                      <div className="surface-sunken rounded-sm border border-line-faint divide-y divide-line-faint overflow-hidden">
                        {data.postmortem.timeline.map((t, idx) => (
                          <div key={t.id || idx} className="flex items-start gap-3 p-2.5 text-xs">
                            <span className="font-mono text-2xs text-ink-4 shrink-0 pt-0.5">
                              {t.formattedTime}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <span className="font-medium text-ink">
                                  {t.actorName || t.actor}
                                </span>
                                {t.actorUserId && (
                                  <span className="font-mono text-[10px] text-ink-4">
                                    ({t.actorUserId})
                                  </span>
                                )}
                                <Badge variant="outline" className="text-[9px] py-0 px-1">
                                  {t.kind.toUpperCase()}
                                </Badge>
                              </div>
                              <p className="text-ink-2 text-xs leading-relaxed">{t.text}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 5. Contradiction & Deliberation Log */}
                  {data.postmortem.contradictions.length > 0 && (
                    <div>
                      <h3 className="eyebrow mb-2">Contradictions & Model Deliberation</h3>
                      <div className="space-y-2">
                        {data.postmortem.contradictions.map((ct) => (
                          <div
                            key={ct.id}
                            className="surface-sunken rounded-sm border border-warning/30 bg-warning/5 p-3"
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-mono text-xs font-semibold text-warning">
                                {ct.id} · {ct.resolved ? "RESOLVED" : "ACTIVE CONFLICT"}
                              </span>
                              <Badge variant={ct.resolved ? "stable" : "warning"}>
                                {ct.relation || "contradiction"}
                              </Badge>
                            </div>
                            <p className="text-xs text-ink-2 mt-1">{ct.why}</p>
                            {ct.speakers && (
                              <p className="mt-1 font-mono text-[10px] text-ink-4">
                                Speakers: {ct.speakers.join(", ")}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 6. SOC2 Cryptographic Action Approvals & Governance Audit */}
                  <div>
                    <h3 className="eyebrow mb-2 flex items-center gap-1.5">
                      <Lock className="h-3 w-3 text-ink-3" />
                      SOC2 Cryptographic Action Approvals & Governance Audit
                    </h3>
                    {data.postmortem.auditLog.length === 0 ? (
                      <div className="surface-sunken rounded-sm border border-line-faint p-4 text-center">
                        <p className="text-xs text-ink-4">
                          No critical gated actions were executed during this session.
                        </p>
                        <p className="font-mono text-[10px] text-ink-4 mt-0.5">
                          All proposed critical actions require dual-channel cryptographic nonce authorization under Rule 4.
                        </p>
                      </div>
                    ) : (
                      <div className="surface-sunken rounded-sm border border-line-faint overflow-x-auto">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead>
                            <tr className="border-b border-line-faint bg-raised/50 font-mono text-2xs text-ink-3">
                              <th className="p-2.5">Time</th>
                              <th className="p-2.5">Action</th>
                              <th className="p-2.5">Outcome</th>
                              <th className="p-2.5">Authorized Human Actor</th>
                              <th className="p-2.5">Audit Detail</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line-faint">
                            {data.postmortem.auditLog.map((entry, i) => (
                              <tr key={i} className="hover:bg-hover/50 transition-colors">
                                <td className="p-2.5 font-mono text-2xs text-ink-4 whitespace-nowrap">
                                  {entry.formattedTime}
                                </td>
                                <td className="p-2.5 font-mono text-xs text-ink font-medium">
                                  {entry.action}
                                </td>
                                <td className="p-2.5">
                                  <Badge
                                    variant={entry.outcome === "APPROVED" ? "live" : "critical"}
                                  >
                                    {entry.outcome}
                                  </Badge>
                                </td>
                                <td className="p-2.5 text-xs text-ink-2">
                                  {entry.actorName ? (
                                    <span>
                                      <strong>{entry.actorName}</strong>{" "}
                                      <span className="font-mono text-2xs text-ink-4">({entry.actorUserId})</span>
                                    </span>
                                  ) : (
                                    <span className="font-mono text-2xs text-ink-4">UID {entry.actorUid}</span>
                                  )}
                                </td>
                                <td className="p-2.5 text-xs text-ink-3 font-mono">
                                  {entry.detail}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="markdown" className="mt-0 relative">
                  <pre className="font-mono text-xs leading-relaxed text-ink-2 bg-void/90 border border-line-strong p-5 rounded-xs overflow-x-auto select-all whitespace-pre-wrap">
                    {markdownContent}
                  </pre>
                </TabsContent>

                <TabsContent value="json" className="mt-0 relative">
                  <pre className="font-mono text-xs leading-relaxed text-ink-2 bg-void/90 border border-line-strong p-5 rounded-xs overflow-x-auto select-all whitespace-pre">
                    {jsonContent}
                  </pre>
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>

        {/* ── Modal Footer ────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-t border-line-faint bg-sunken/60 px-5 py-2.5 text-2xs text-ink-4 shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-mono">SOC2 Type II / HIPAA Gated Audit</span>
            <span>·</span>
            <span>Generated from verified Ledger state</span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Fallback synthesizer if Slow Loop is in transit or during rehearsal playback.
 */
function synthesizeFallback(state: IncidentState, now: number): PostMortemResponse {
  const started = state.startedAt || now - 300000;
  const closed = now;
  const diffSec = Math.max(0, Math.floor((closed - started) / 1000));
  const m = Math.floor(diffSec / 60);
  const s = diffSec % 60;
  const duration = `${m}m ${s}s`;

  const entities = state.entities.map((e: IncidentEntity) => ({
    id: e.id,
    label: e.label,
    kind: e.kind,
    status: e.status,
    metric: null,
  }));

  const timeline = (state.transcripts || []).map((t: Transcript) => ({
    id: t.messageId,
    kind: "signal",
    text: t.text,
    actor: t.role,
    actorName: t.speakerName || null,
    actorUserId: t.speakerUserId || null,
    at: t.at || now,
    formattedTime: new Date(t.at || now).toISOString().substring(11, 19) + " UTC",
  }));

  const claims = state.claims || [];
  const observed = claims.filter((c: Claim) => c.epistemicStatus === "OBSERVED");
  const hypothesis = claims.filter((c: Claim) => c.epistemicStatus === "HYPOTHESIS");
  const inferred = claims.filter((c: Claim) => c.epistemicStatus === "INFERRED");
  const refutedOrStale = claims.filter((c: Claim) => c.lifecycle === "REFUTED" || c.lifecycle === "SUPERSEDED");

  const postmortem = {
    overview: {
      incidentId: state.id,
      channel: state.id.toLowerCase(),
      phase: state.phase.toUpperCase(),
      startedAt: started,
      startedAtFormatted: new Date(started).toISOString().substring(0, 19).replace("T", " ") + " UTC",
      closedAt: closed,
      closedAtFormatted: new Date(closed).toISOString().substring(0, 19).replace("T", " ") + " UTC",
      duration,
      peakRti: state.rti,
      status: state.phase === "resolved" ? "RESOLVED" : "ACTIVE",
    },
    entities,
    timeline,
    epistemicClaims: {
      observed,
      hypothesis,
      inferred,
      refutedOrStale,
    },
    contradictions: state.contradictions || [],
    tasks: state.tasks || [],
    auditLog: [],
    privacy: state.privacy as unknown as Record<string, unknown>,
    epistemicNeutralityDisclaimer:
      "Rule 1 Compliance: EchoSphere operates as a non-causal recording secretary. Root cause determination is deferred to offline engineering review.",
  };

  const lines: string[] = [
    `# Incident Post-Mortem Report: ${postmortem.overview.incidentId}`,
    `> **Status:** \`${postmortem.overview.status}\` | **Duration:** \`${duration}\` | **Peak RTI:** \`${postmortem.overview.peakRti}\``,
    "",
    "---",
    "## 1. Executive Summary",
    `- **Incident Identifier:** \`${postmortem.overview.incidentId}\``,
    `- **Bridge Duration:** ${duration}`,
    `- **Closing Phase:** \`${postmortem.overview.phase}\``,
    "",
    "> [!NOTE]",
    "> **Epistemic Discipline Disclaimer (Rule 1):**",
    `> ${postmortem.epistemicNeutralityDisclaimer}`,
    "",
    "---",
    "## 2. Impacted Topology & Subsystems",
    "",
  ];

  if (entities.length > 0) {
    lines.push("| System Name | Kind | Status |");
    lines.push("|---|---|---|");
    for (const e of entities) {
      lines.push(`| **${e.label}** | \`${e.kind}\` | **${e.status}** |`);
    }
  } else {
    lines.push("*No subsystems registered.*");
  }

  lines.push("");
  lines.push("---");
  lines.push("## 3. Epistemic Evidence Ledger");
  lines.push("");
  lines.push("### 3.1 Observed Telemetry (Confirmed Facts)");
  if (observed.length > 0) {
    for (const c of observed) {
      lines.push(`- ✓ **"${c.text}"** (*Source:* ${c.speakerName || c.speakerRole})`);
    }
  } else {
    lines.push("*No confirmed telemetry claims recorded.*");
  }

  lines.push("");
  lines.push("### 3.2 Open Hypotheses (Unverified)");
  if (hypothesis.length > 0) {
    for (const c of hypothesis) {
      lines.push(`- ❓ **"${c.text}"** (*Unverified Hypothesis* - *Source:* ${c.speakerName || c.speakerRole})`);
    }
  } else {
    lines.push("*No unverified hypotheses.*");
  }

  return {
    postmortem,
    markdown: lines.join("\n"),
  };
}
