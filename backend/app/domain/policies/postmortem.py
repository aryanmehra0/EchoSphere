"""
Post-Mortem & SOC2 Audit Generator — Domain Policy.

── RULE 1 INVARIANT (EPISTEMIC DISCIPLINE) ──────────────────────────────────
Echo never asserts causation or determines root cause. The post-mortem
structures observed facts, open hypotheses, and contradictions, but
explicitly disclaims root causation:
"Root cause analysis deferred to offline post-incident engineering review;
 Echo maintains epistemic neutrality during live response."
──────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import datetime
from typing import Any

from app.domain.ledger import Ledger
from app.domain.models import Claim, Contradiction, Task, TimelineEvent, now_ms
from app.domain.policies.authorization import AuditEntry


def _format_timestamp(ms: int | float) -> str:
    """Format millisecond timestamp to ISO 8601 UTC string."""
    try:
        dt = datetime.datetime.fromtimestamp(ms / 1000.0, tz=datetime.timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    except Exception:
        return str(ms)


def _format_duration(start_ms: int, end_ms: int) -> str:
    """Format duration in human-readable string (e.g., '14m 23s')."""
    total_seconds = max(0, int((end_ms - start_ms) / 1000))
    minutes, seconds = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours > 0:
        return f"{hours}h {minutes}m {seconds}s"
    return f"{minutes}m {seconds}s"


def generate_postmortem(
    ledger: Ledger,
    audit_entries: list[AuditEntry] | None = None,
    privacy_inventory: dict[str, Any] | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """
    Generate structured, serializable post-mortem and SOC2 audit data.
    Pure domain logic with zero external dependencies.
    """
    end_ms = now or now_ms()
    start_ms = ledger.started_at
    duration_str = _format_duration(start_ms, end_ms)

    # 1. Executive Overview
    overview = {
        "incidentId": ledger.incident_id,
        "channel": ledger.channel,
        "phase": ledger.phase.upper(),
        "startedAt": start_ms,
        "startedAtFormatted": _format_timestamp(start_ms),
        "closedAt": end_ms,
        "closedAtFormatted": _format_timestamp(end_ms),
        "duration": duration_str,
        "peakRti": round(ledger.rti, 2),
        "status": "RESOLVED" if ledger.phase.lower() == "resolved" else "ACTIVE",
    }

    # 2. System Topology & Affected Entities
    entities_list = [
        {
            "id": e.id,
            "label": e.label,
            "kind": e.kind,
            "status": e.status,
            "metric": e.metric,
            "aliases": e.aliases,
        }
        for e in ledger.entities.values()
    ]

    # 3. Attributed Timeline of Events
    timeline_list = [
        {
            "id": event.id,
            "kind": event.kind,
            "text": event.text,
            "actor": event.actor,
            "actorName": event.actor_name,
            "actorUserId": event.actor_user_id,
            "at": event.at,
            "formattedTime": _format_timestamp(event.at),
        }
        for event in sorted(ledger.timeline, key=lambda t: t.at)
    ]

    # 4. Epistemic Classification of Claims
    claims_observed: list[dict[str, Any]] = []
    claims_hypothesis: list[dict[str, Any]] = []
    claims_inferred: list[dict[str, Any]] = []
    claims_refuted_or_stale: list[dict[str, Any]] = []

    for c in sorted(ledger.claims.values(), key=lambda cl: cl.at):
        item = {
            "id": c.id,
            "text": c.text,
            "speakerRole": c.speaker_role,
            "speakerName": c.speaker_name,
            "speakerUserId": c.speaker_user_id,
            "confidence": c.confidence,
            "entity": c.entity,
            "lifecycle": c.lifecycle,
            "at": c.at,
            "formattedTime": _format_timestamp(c.at),
        }
        if c.lifecycle in ("REFUTED", "STALE", "SUPERSEDED"):
            claims_refuted_or_stale.append(item)
        elif c.epistemic_status == "OBSERVED":
            claims_observed.append(item)
        elif c.epistemic_status == "HYPOTHESIS":
            claims_hypothesis.append(item)
        elif c.epistemic_status == "INFERRED":
            claims_inferred.append(item)

    # 5. Contradictions & Deliberation Consensuses
    contradictions_list = [
        {
            "id": ct.id,
            "claimA": ct.claim_a,
            "claimB": ct.claim_b,
            "speakers": ct.speakers,
            "resolved": ct.resolved,
            "relation": ct.relation,
            "why": ct.why,
            "panel": ct.panel,
            "at": ct.at,
            "formattedTime": _format_timestamp(ct.at),
        }
        for ct in ledger.contradictions.values()
    ]

    # 6. Tasks & Action Items
    tasks_list = [
        {
            "id": t.id,
            "description": t.description,
            "assigneeRole": t.assignee_role,
            "status": t.status,
            "ref": t.ref,
            "at": t.at,
        }
        for t in ledger.tasks.values()
    ]

    # 7. SOC2 Cryptographic Action Approvals & Governance Audit
    audit_list = []
    if audit_entries:
        for entry in audit_entries:
            audit_list.append({
                "at": int(entry.at * 1000),
                "formattedTime": _format_timestamp(entry.at * 1000),
                "actorUid": entry.actor,
                "actorName": entry.actor_name,
                "actorUserId": entry.actor_user_id,
                "action": entry.action,
                "outcome": entry.outcome,
                "detail": entry.detail,
            })

    # 8. Privacy & Consent Summary
    privacy_summary = privacy_inventory or {
        "claims": len(ledger.claims),
        "entities": len(ledger.entities),
        "transcripts": len(ledger.timeline),
        "redactions": 0,
        "retention": "purged_on_reset",
    }

    return {
        "overview": overview,
        "entities": entities_list,
        "timeline": timeline_list,
        "epistemicClaims": {
            "observed": claims_observed,
            "hypothesis": claims_hypothesis,
            "inferred": claims_inferred,
            "refutedOrStale": claims_refuted_or_stale,
        },
        "contradictions": contradictions_list,
        "tasks": tasks_list,
        "auditLog": audit_list,
        "privacy": privacy_summary,
        "epistemicNeutralityDisclaimer": (
            "Rule 1 Compliance: EchoSphere operates as a non-causal recording secretary. "
            "Root cause determination is deferred to offline post-incident engineering review; "
            "Echo enforces strict epistemic neutrality."
        ),
    }


def generate_markdown_report(data: dict[str, Any]) -> str:
    """
    Format post-mortem data into clean GitHub Flavored Markdown (GFM).
    Suitable for export to Jira, Confluence, GitHub Incident Issues, or PDF.
    """
    ov = data["overview"]
    claims = data["epistemicClaims"]

    lines: list[str] = []
    lines.append(f"# Incident Post-Mortem Report: {ov['incidentId']}")
    lines.append("")
    lines.append(f"> **Status:** `{ov['status']}` | **Channel:** `{ov['channel']}` | **Duration:** `{ov['duration']}` | **Peak RTI:** `{ov['peakRti']}`")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 1. Executive Summary")
    lines.append("")
    lines.append(f"- **Incident Identifier:** `{ov['incidentId']}`")
    lines.append(f"- **Time of Origin:** {ov['startedAtFormatted']}")
    lines.append(f"- **Close-out Time:** {ov['closedAtFormatted']}")
    lines.append(f"- **Total Bridge Duration:** {ov['duration']}")
    lines.append(f"- **Peak Room Tension Index (RTI):** {ov['peakRti']}")
    lines.append(f"- **Closing Phase:** `{ov['phase']}`")
    lines.append("")
    lines.append("> [!NOTE]")
    lines.append(f"> **Epistemic Discipline Disclaimer (Rule 1):**")
    lines.append(f"> {data['epistemicNeutralityDisclaimer']}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 2. Impacted Topology & Subsystems")
    lines.append("")
    if data["entities"]:
        lines.append("| Entity ID | System Name | Kind | Status | Metric / Telemetry |")
        lines.append("|---|---|---|---|---|")
        for e in data["entities"]:
            metric = e.get("metric") or "—"
            lines.append(f"| `{e['id']}` | **{e['label']}** | `{e['kind']}` | `{e['status']}` | {metric} |")
    else:
        lines.append("*No infrastructure subsystems registered.*")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 3. Attributed Chronological Timeline")
    lines.append("")
    if data["timeline"]:
        for t in data["timeline"]:
            actor_str = f"**{t['actorName']}** ({t['actor']})" if t.get("actorName") else f"**{t['actor']}**"
            lines.append(f"- **{t['formattedTime']}** — [{t['kind'].upper()}] {actor_str}: {t['text']}")
    else:
        lines.append("*No timeline events recorded.*")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 4. Epistemic Evidence Ledger")
    lines.append("")
    lines.append("### 4.1 Established Facts (Observed Telemetry)")
    if claims["observed"]:
        for c in claims["observed"]:
            speaker = f"{c['speakerName']} ({c['speakerRole']})" if c.get("speakerName") else c['speakerRole']
            lines.append(f"- ✓ **\"{c['text']}\"**")
            lines.append(f"  *Source:* {speaker} | *Confidence:* {int(c['confidence'] * 100)}% | *Entity:* `{c['entity'] or 'general'}` | *Time:* {c['formattedTime']}")
    else:
        lines.append("*No confirmed facts recorded.*")
    lines.append("")

    lines.append("### 4.2 Open Hypotheses & Hedges")
    if claims["hypothesis"]:
        for c in claims["hypothesis"]:
            speaker = f"{c['speakerName']} ({c['speakerRole']})" if c.get("speakerName") else c['speakerRole']
            lines.append(f"- ❓ **\"{c['text']}\"** *(Unverified)*")
            lines.append(f"  *Source:* {speaker} | *Confidence:* {int(c['confidence'] * 100)}% | *Time:* {c['formattedTime']}")
    else:
        lines.append("*No active unproven hypotheses.*")
    lines.append("")

    if claims["inferred"]:
        lines.append("### 4.3 Automated System Inferences (Echo Secretary)")
        for c in claims["inferred"]:
            lines.append(f"- ℹ️ **\"{c['text']}\"** *(Non-Causal AI Deduction)*")
            lines.append(f"  *Confidence:* {int(c['confidence'] * 100)}% | *Entity:* `{c['entity'] or 'general'}`")
        lines.append("")

    if claims["refutedOrStale"]:
        lines.append("### 4.4 Refuted, Superseded, or Stale Telemetry")
        for c in claims["refutedOrStale"]:
            lines.append(f"- ⚠️ **\"{c['text']}\"** — Lifecycle: `{c['lifecycle']}`")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("## 5. Contradiction & Model Deliberation Analysis")
    lines.append("")
    if data["contradictions"]:
        for ct in data["contradictions"]:
            status = "RESOLVED" if ct["resolved"] else "OPEN"
            lines.append(f"### Contradiction `{ct['id']}` [{status}]")
            lines.append(f"- **Speakers Involved:** {', '.join(ct['speakers'])}")
            lines.append(f"- **Adjudication Relation:** `{ct['relation']}`")
            lines.append(f"- **Deliberation Finding:** {ct['why']}")
            lines.append("")
    else:
        lines.append("*No opposing observations or contradictions detected during incident.*")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("## 6. SOC2 Action Gate & Governance Audit Log")
    lines.append("")
    if data["auditLog"]:
        lines.append("| Timestamp | Action | Outcome | Authorized Human Actor | Context / Ref |")
        lines.append("|---|---|---|---|---|")
        for a in data["auditLog"]:
            actor = f"{a['actorName']} ({a['actorUserId']})" if a.get("actorName") else (f"UID {a['actorUid']}" if a.get("actorUid") else "System")
            lines.append(f"| {a['formattedTime']} | `{a['action']}` | **{a['outcome']}** | {actor} | {a['detail']} |")
    else:
        lines.append("*No critical gated actions redeemed during this incident.*")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("## 7. Action Items & Follow-up Tasks")
    lines.append("")
    if data["tasks"]:
        for t in data["tasks"]:
            ref_str = f" (Ref: `{t['ref']}`)" if t.get("ref") else ""
            lines.append(f"- [ ] **[{t['status']}]** {t['description']} — *Assignee:* `{t['assigneeRole']}`{ref_str}")
    else:
        lines.append("*No follow-up action items created.*")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("## 8. Compliance & Data Privacy Verification")
    lines.append("")
    priv = data["privacy"]
    lines.append(f"- **Session Claims Extracted:** {priv.get('claims', 0)}")
    lines.append(f"- **PII Redaction Spans Cleansed:** {priv.get('redactions', 0)}")
    lines.append(f"- **Data Retention Policy:** `{priv.get('retention', 'session_only')}`")
    lines.append("")

    return "\n".join(lines)
