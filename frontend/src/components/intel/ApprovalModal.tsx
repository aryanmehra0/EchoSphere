"use client";

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Signal";

/**
 * The Authorization Gate's human half — v6 §10.2, closing G7.
 *
 * ── WHY THIS SCREEN EXISTS ──────────────────────────────────────────────────
 * v5's gate was a spoken "yes, approved". The channel carries audio, and audio
 * can be produced by a recording, an imitation, or a TTS clip in a shared
 * screen. There is no binding between "those words appeared on UID 1001's
 * stream" and "the human who owns UID 1001 intended to authorize THIS action".
 *
 * So voice is demoted to an intent signal, and the authorization is this: a
 * single-use nonce, expiring in 120 seconds, bound by hash to these exact
 * arguments, redeemed from an authenticated session belonging to a role that
 * carries the permission. Two independent channels must agree.
 *
 * On stage this is the beat where the presenter says "yes, do it" and NOTHING
 * HAPPENS — then clicks here. That pause is the security model made visible.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Two deliberate choices:
 *
 *   1. The full arguments and the evidence chain are shown. A human approves
 *      against the RECORD, not against Echo's summary of the record — which is
 *      the same epistemic discipline §6 applies to Echo, applied to the UI.
 *   2. There is no dismiss "X". The only ways out are Approve, Deny, or letting
 *      it expire, and all three are audited. Sweeping an authorization request
 *      off the screen without a ruling would be indistinguishable in the audit
 *      log from a decision.
 */

const SLOW_LOOP = process.env.NEXT_PUBLIC_SLOW_LOOP_HTTP ?? "http://127.0.0.1:8000";

export function ApprovalModal() {
  const { state, dispatch, currentUid, currentRole } = useIncident();
  const { user } = useAuth();
  const approval = state.approval;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  /**
   * The TTL counts down visibly.
   *
   * An approval that has silently expired, on a screen that still offers an
   * Approve button, is the sort of thing that produces "I clicked it and
   * nothing happened" at the worst possible moment.
   */
  useEffect(() => {
    if (!approval) return;

    const tick = () => {
      const left = Math.max(0, approval.expiresAt - Date.now());
      setRemaining(left);
      if (left === 0) dispatch({ type: "APPROVAL_RESOLVED" });
    };

    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [approval, dispatch]);

  if (!approval) return null;

  const seconds = Math.ceil(remaining / 1000);
  const urgent = seconds <= 30;

  const canApprove =
    user.permissions.includes("APPROVE_CRITICAL_ACTIONS") ||
    currentRole === "Incident Commander" ||
    currentRole === "DevOps Lead";

  async function decide(path: "redeem" | "deny") {
    if (!approval) return;
    if (path === "redeem" && !canApprove) {
      setError(
        `Insufficient authority: ${user.name} (${user.defaultRole}) cannot approve CRITICAL actions. Requires Incident Commander or DevOps Lead.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${SLOW_LOOP}/approval/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nonce: approval.nonce,
          uid: currentUid ?? 1001,
          role: currentRole ?? user.defaultRole ?? approval.requiredRole,
          actorName: user.name,
          actorUserId: user.id,
          args: approval.args,
          evidence: approval.evidence?.map((c) => c.id) ?? [],
        }),
      });
      const body = await res.json();
      if (body.status === "REJECTED") {
        setError(body.detail ?? "The gate rejected this approval.");
        setBusy(false);
        return;
      }
      dispatch({ type: "APPROVAL_RESOLVED" });
    } catch {
      setError("Could not reach the Slow Loop. Nothing was approved.");
      setBusy(false);
    }
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-void/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
    >
      <div
        className={cn(
          "enter-up w-full max-w-[560px] overflow-hidden rounded-md border bg-raised",
          "shadow-[0_0_0_1px_oklch(0_0_0/40%),0_24px_60px_-16px_oklch(0_0_0/85%)]",
          urgent ? "border-critical/50" : "border-warning/45",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2 border-b px-4 py-2",
            urgent
              ? "border-critical/25 bg-critical/10"
              : "border-warning/25 bg-warning/10",
          )}
        >
          <ShieldAlert
            size={13}
            strokeWidth={2.2}
            className={urgent ? "text-critical" : "text-warning"}
          />
          <span
            id="approval-title"
            className={cn(
              "text-2xs font-semibold tracking-[0.08em] uppercase",
              urgent ? "text-critical" : "text-warning",
            )}
          >
            Authorization required
          </span>
          <span
            className={cn(
              "tnum ml-auto font-mono text-2xs",
              urgent ? "text-critical" : "text-warning/80",
            )}
            title="This approval expires — it cannot be banked for later"
          >
            {seconds}s
          </span>
        </div>

        <div className="px-4 py-3">
          <p className="font-mono text-sm text-ink">{approval.action}</p>
          <p className="mt-1 text-2xs text-ink-4">
            Requires <span className="text-ink-2">{approval.requiredRole}</span>.
            Echo cannot authorize this from voice.
          </p>

          {/* The exact arguments the nonce is hash-bound to. */}
          <div className="mt-3">
            <p className="eyebrow mb-1.5">Arguments</p>
            <dl className="surface-sunken rounded-sm px-2.5 py-2">
              {Object.entries(approval.args).map(([k, v]) => (
                <div key={k} className="flex gap-2 py-px">
                  <dt className="font-mono text-[10px] text-ink-4">{k}</dt>
                  <dd className="font-mono text-[10px] text-ink-2">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Why this was proposed at all — v6 §9.4's evidence chain. */}
          {approval.evidence && approval.evidence.length > 0 ? (
            <div className="mt-3">
              <p className="eyebrow mb-1.5">Evidence</p>
              <ul className="space-y-1 border-l border-line pl-2.5">
                {approval.evidence.map((c) => (
                  <li key={c.id} className="text-[10px] leading-snug text-ink-3">
                    <span className="text-ink-4">{c.speakerRole}:</span> {c.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {!canApprove && (
            <p className="mt-3 rounded-xs border border-warning/30 bg-warning/10 px-2 py-1.5 text-2xs text-warning">
              Approval restricted: Requires Incident Commander or DevOps Lead authority. You are signed in as {user.name} ({user.defaultRole}).
            </p>
          )}

          {error ? (
            <p className="mt-3 rounded-xs border border-critical/30 bg-critical/10 px-2 py-1.5 text-2xs text-critical">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-line-faint bg-sunken/60 px-4 py-2.5">
          <Badge tone="neutral" variant="outline">
            nonce · single use
          </Badge>
          <p className="text-[10px] text-ink-4">
            No infrastructure changes. This files a request.
          </p>

          <div className="ml-auto flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => decide("deny")}>
              Deny
            </Button>
            <Button
              variant="primary"
              disabled={busy || !canApprove}
              title={!canApprove ? "Requires Incident Commander or DevOps Lead authority" : undefined}
              onClick={() => decide("redeem")}
            >
              {busy ? "Filing…" : "Approve"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
