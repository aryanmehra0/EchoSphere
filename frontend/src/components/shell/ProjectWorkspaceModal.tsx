"use client";

import { useState } from "react";
import {
  Activity,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Layers,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  Server,
  Sliders,
  Users,
  Zap,
} from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { useAuth } from "@/lib/auth-context";
import {
  testConnectorConnection,
  createProjectIncident,
} from "@/lib/delta-socket";
import { cn } from "@/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/Button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import type {
  ConnectorProvider,
  ConnectorStatus,
  ProjectWorkspace,
} from "@/lib/types";

function getConnectorStatusBadge(status: ConnectorStatus) {
  switch (status) {
    case "CONNECTED":
      return <Badge variant="live" className="text-[10px] uppercase font-mono">Connected</Badge>;
    case "CONFIGURED":
      return <Badge variant="soft" className="text-[10px] uppercase font-mono border-blue-500/40 text-blue-400">Configured</Badge>;
    case "ERROR":
      return <Badge variant="critical" className="text-[10px] uppercase font-mono">Error</Badge>;
    default:
      return <Badge variant="neutral" className="text-[10px] uppercase font-mono">Unconfigured</Badge>;
  }
}

function getProviderIcon(provider: ConnectorProvider) {
  switch (provider) {
    case "prometheus":
      return <Activity className="h-4 w-4 text-orange-400" />;
    case "datadog":
      return <Zap className="h-4 w-4 text-purple-400" />;
    case "cloudwatch":
      return <Cloud className="h-4 w-4 text-cyan-400" />;
    case "grafana_loki":
      return <Sliders className="h-4 w-4 text-amber-400" />;
    case "slack":
      return <Radio className="h-4 w-4 text-emerald-400" />;
    default:
      return <Server className="h-4 w-4 text-ink-3" />;
  }
}

function getRoleBadge(role: string) {
  switch (role) {
    case "Incident Commander":
      return <Badge variant="live" className="text-[10px]">IC</Badge>;
    case "DevOps Lead":
      return <Badge variant="soft" className="border-cyan-500/40 bg-cyan-500/15 text-cyan-400 text-[10px]">DevOps</Badge>;
    case "Site Reliability Engineer":
      return <Badge variant="soft" className="border-blue-500/40 bg-blue-500/15 text-blue-400 text-[10px]">SRE</Badge>;
    case "Database Admin":
      return <Badge variant="warning" className="text-[10px]">DBA</Badge>;
    case "Product Manager":
      return <Badge variant="soft" className="border-purple-500/40 bg-purple-500/15 text-purple-400 text-[10px]">PM</Badge>;
    default:
      return <Badge variant="neutral" className="text-[10px]">{role}</Badge>;
  }
}

export function ProjectWorkspaceModal() {
  const {
    projectModalOpen,
    setProjectModalOpen,
    activeProject,
    projects,
    selectProject,
    refreshProjects,
    openBridge,
  } = useIncident();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState("connectors");
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { status: ConnectorStatus; latencyMs: number; message: string; metricsDiscovered?: number }>
  >({});
  const [newIncidentTitle, setNewIncidentTitle] = useState("");
  const [newIncidentSeverity, setNewIncidentSeverity] = useState<number>(1);
  const [newIncidentChannel, setNewIncidentChannel] = useState("");
  const [creatingIncident, setCreatingIncident] = useState(false);

  if (!activeProject && projects.length === 0) return null;

  const currentProj: ProjectWorkspace =
    activeProject ||
    projects[0] || {
      id: "proj-payments",
      slug: "payments-core",
      name: "Payments & Checkout Core",
      description: "Core payment authorization, cart settlement, and transaction database pipeline.",
      environment: "production",
      team: [],
      connectors: {},
      activeIncidents: [],
    };

  const handleTestConnector = async (provider: ConnectorProvider, endpoint?: string) => {
    setTestingProvider(provider);
    try {
      const result = await testConnectorConnection(currentProj.id, {
        provider,
        endpoint,
      });
      setTestResults((prev) => ({ ...prev, [provider]: result }));
      await refreshProjects();
    } finally {
      setTestingProvider(null);
    }
  };

  const handleCreateIncident = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIncidentTitle.trim()) return;
    setCreatingIncident(true);
    try {
      const inc = await createProjectIncident(currentProj.id, {
        title: newIncidentTitle.trim(),
        severity: newIncidentSeverity,
        channel: newIncidentChannel.trim() || `inc-${Math.floor(Date.now() / 1000) % 10000}`,
      });
      if (inc) {
        setNewIncidentTitle("");
        setNewIncidentChannel("");
        await refreshProjects();
        // Immediately connect to the newly created war room
        void openBridge({
          channel: inc.channel,
          role: user.defaultRole,
          userId: user.id,
          name: user.name,
        });
        setProjectModalOpen(false);
      }
    } finally {
      setCreatingIncident(false);
    }
  };

  return (
    <Dialog open={projectModalOpen} onOpenChange={setProjectModalOpen}>
      <DialogContent className="max-w-3xl border-line-strong bg-base p-0 overflow-hidden shadow-2xl">
        {/* Header Strip */}
        <div className="border-b border-line bg-raised px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xs border border-line-strong bg-sunken text-ink">
                <Layers className="h-5 w-5 text-live" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <DialogTitle className="text-base font-semibold text-ink">
                    Enterprise Project Workspace
                  </DialogTitle>
                  <Badge variant="soft" className="uppercase font-mono text-[10px]">
                    {currentProj.environment}
                  </Badge>
                </div>
                <DialogDescription className="text-xs text-ink-3">
                  Observability tool connectors, responder team roster, and outage war rooms
                </DialogDescription>
              </div>
            </div>

            {/* Project Switcher */}
            <div className="flex items-center gap-1.5 mr-6">
              <span className="text-2xs text-ink-4 uppercase font-mono">Project:</span>
              <select
                aria-label="Select enterprise project"
                value={currentProj.id}
                onChange={(e) => void selectProject(e.target.value)}
                className="h-8 rounded-xs border border-line bg-sunken px-2.5 text-xs text-ink focus:border-focus focus:outline-none cursor-pointer"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Tabbed Navigation & Content */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="border-b border-line px-6 py-2 bg-sunken/40">
            <TabsList className="bg-transparent border-0 gap-2 p-0 h-auto">
              <TabsTrigger
                value="connectors"
                className="gap-2 text-xs py-1.5 px-3 data-[state=active]:bg-raised data-[state=active]:text-ink"
              >
                <Activity className="h-3.5 w-3.5 text-orange-400" />
                <span>Observability Connectors</span>
                <Badge variant="live" className="ml-1 px-1.5 py-0 text-[10px]">
                  {Object.values(currentProj.connectors).filter((c) => c.status === "CONNECTED").length}
                </Badge>
              </TabsTrigger>

              <TabsTrigger
                value="team"
                className="gap-2 text-xs py-1.5 px-3 data-[state=active]:bg-raised data-[state=active]:text-ink"
              >
                <Users className="h-3.5 w-3.5 text-cyan-400" />
                <span>Team & Responders</span>
                <span className="text-[10px] text-ink-4">({currentProj.team.length})</span>
              </TabsTrigger>

              <TabsTrigger
                value="incidents"
                className="gap-2 text-xs py-1.5 px-3 data-[state=active]:bg-raised data-[state=active]:text-ink"
              >
                <Radio className="h-3.5 w-3.5 text-critical" />
                <span>War Rooms & Channels</span>
                <span className="text-[10px] text-ink-4">({currentProj.activeIncidents.length})</span>
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="p-6 max-h-[60vh] overflow-y-auto">
            {/* ── TAB 1: CONNECTORS ────────────────────────────────────── */}
            <TabsContent value="connectors" className="m-0 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-ink">Connected Observability Pipeline</h3>
                  <p className="text-xs text-ink-3">
                    EchoSphere queries these endpoints for active telemetry verification and hypothesis refutation.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  onClick={() => void refreshProjects()}
                >
                  Refresh
                </Button>
              </div>

              <div className="grid gap-3">
                {Object.entries(currentProj.connectors).map(([key, conn]) => {
                  const test = testResults[conn.provider];
                  const isTesting = testingProvider === conn.provider;

                  return (
                    <div
                      key={key}
                      className="flex flex-col gap-2 rounded-xs border border-line bg-raised/70 p-3.5 transition-colors hover:border-line-strong"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-7 w-7 items-center justify-center rounded-xs border border-line bg-sunken">
                            {getProviderIcon(conn.provider)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-ink">{conn.name}</span>
                              {getConnectorStatusBadge(test ? test.status : conn.status)}
                            </div>
                            <span className="font-mono text-2xs text-ink-4">
                              {conn.endpoint || (conn.region ? `AWS Region: ${conn.region}` : "No endpoint configured")}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {conn.latencyMs !== null && conn.latencyMs !== undefined && (
                            <span className="font-mono text-2xs text-ink-3">
                              {test ? `${test.latencyMs}ms` : `${conn.latencyMs}ms`}
                            </span>
                          )}
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={isTesting}
                            onClick={() => void handleTestConnector(conn.provider, conn.endpoint)}
                            icon={
                              isTesting ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5 text-live" />
                              )
                            }
                          >
                            {isTesting ? "Pinging..." : "Test Connection"}
                          </Button>
                        </div>
                      </div>

                      {/* Secret & Service Metadata */}
                      <div className="flex items-center gap-4 text-2xs font-mono text-ink-4 border-t border-line-faint pt-2 mt-1">
                        {conn.authMasked && (
                          <span>Token: <span className="text-ink-3">{conn.authMasked}</span></span>
                        )}
                        {conn.serviceFilter && (
                          <span>Services: <span className="text-ink-3">{conn.serviceFilter}</span></span>
                        )}
                        {test && (
                          <span className={cn("ml-auto", test.status === "CONNECTED" ? "text-live" : "text-critical")}>
                            {test.message}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </TabsContent>

            {/* ── TAB 2: TEAM ROSTER ───────────────────────────────────── */}
            <TabsContent value="team" className="m-0 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-ink">Project Responders & On-Call Team</h3>
                  <p className="text-xs text-ink-3">
                    Engineers, PMs, and on-call leads authenticated to authorize bridge actions and review telemetry.
                  </p>
                </div>
              </div>

              <div className="rounded-xs border border-line divide-y divide-line bg-raised/50">
                {currentProj.team.map((member) => (
                  <div key={member.userId} className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-7 w-7 border border-line">
                        <AvatarFallback className="text-2xs font-semibold text-ink-2">
                          {member.name.slice(0, 1)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-ink">{member.name}</span>
                          {getRoleBadge(member.role)}
                          {member.isOnline && (
                            <span className="flex h-1.5 w-1.5 rounded-full bg-live ring-2 ring-live/20" />
                          )}
                        </div>
                        <span className="text-2xs text-ink-4 font-mono">{member.email}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {member.permissions && member.permissions.includes("APPROVE_CRITICAL_ACTIONS") && (
                        <Badge variant="soft" className="text-[9px] border-amber-500/40 text-amber-400">
                          Approver
                        </Badge>
                      )}
                      <span className="text-2xs text-ink-4 font-mono uppercase">
                        {member.userId}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>

            {/* ── TAB 3: WAR ROOMS ─────────────────────────────────────── */}
            <TabsContent value="incidents" className="m-0 space-y-5">
              <div>
                <h3 className="text-sm font-medium text-ink">Active & Historical War Room Channels</h3>
                <p className="text-xs text-ink-3">
                  Each incident channel binds project observability connectors to EchoSphere live voice command.
                </p>
              </div>

              {/* Active War Rooms List */}
              <div className="space-y-2.5">
                {currentProj.activeIncidents.map((inc) => (
                  <div
                    key={inc.id}
                    className="flex items-center justify-between rounded-xs border border-line bg-raised/70 p-3.5 transition-colors hover:border-line-strong"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-xs border border-critical/40 bg-critical/15 text-critical">
                        <Radio className="h-4 w-4" />
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-ink">{inc.title}</span>
                          <Badge variant="critical" className="text-[9px]">
                            Sev {inc.severity}
                          </Badge>
                          <Badge variant="soft" className="text-[9px] uppercase font-mono">
                            {inc.status}
                          </Badge>
                        </div>
                        <span className="font-mono text-2xs text-ink-4">Channel: {inc.channel}</span>
                      </div>
                    </div>

                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        void openBridge({
                          channel: inc.channel,
                          role: user.defaultRole,
                          userId: user.id,
                          name: user.name,
                        });
                        setProjectModalOpen(false);
                      }}
                      icon={<ExternalLink className="h-3 w-3" />}
                    >
                      Join War Room
                    </Button>
                  </div>
                ))}
              </div>

              {/* Spin Up New War Room Form */}
              <form
                onSubmit={handleCreateIncident}
                className="rounded-xs border border-line bg-sunken/40 p-4 space-y-3"
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-ink">
                  <Plus className="h-3.5 w-3.5 text-live" />
                  <span>Spin Up New Outage War Room Channel</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div className="sm:col-span-2">
                    <label className="block text-2xs text-ink-4 mb-1 uppercase font-mono">
                      Incident Title
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Redis Cache Eviction Cascade & Checkout Degradation"
                      value={newIncidentTitle}
                      onChange={(e) => setNewIncidentTitle(e.target.value)}
                      className="w-full h-8 rounded-xs border border-line bg-raised px-2.5 text-xs text-ink placeholder:text-ink-4 focus:border-focus focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-2xs text-ink-4 mb-1 uppercase font-mono">
                      Severity
                    </label>
                    <select
                      aria-label="Incident Severity"
                      value={newIncidentSeverity}
                      onChange={(e) => setNewIncidentSeverity(Number(e.target.value))}
                      className="w-full h-8 rounded-xs border border-line bg-raised px-2 text-xs text-ink focus:border-focus focus:outline-none"
                    >
                      <option value={1}>Sev-1 (Critical Outage)</option>
                      <option value={2}>Sev-2 (Degraded Performance)</option>
                      <option value={3}>Sev-3 (Minor Warning)</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-2xs text-ink-4 font-mono">
                    Channel will auto-inherit {currentProj.name} telemetry connectors & roster.
                  </span>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={creatingIncident || !newIncidentTitle.trim()}
                    icon={creatingIncident ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
                  >
                    {creatingIncident ? "Creating..." : "Launch War Room"}
                  </Button>
                </div>
              </form>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

