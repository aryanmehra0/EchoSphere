/**
 * Formatting primitives.
 *
 * All of these are deterministic and locale-fixed. That is deliberate: an
 * incident log is a legal-ish artefact that gets pasted into a post-mortem, so
 * "14:02:31" must mean the same thing to every operator on the bridge
 * regardless of where their browser thinks it is. It also keeps the server and
 * client renders identical, which avoids hydration mismatch on the clock.
 */

/** `MM:SS` for elapsed time under an hour, `H:MM:SS` beyond it. */
export function elapsed(fromMs: number | null, nowMs: number): string {
  if (fromMs === null) return "--:--";

  const total = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Wall clock as `HH:MM:SS`, 24-hour, for timeline entries. */
export function clock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `HH:MM` — used where seconds are noise. */
export function clockShort(ms: number): string {
  return clock(ms).slice(0, 5);
}

/** `0.93` → `93%`. Confidence is always shown as an integer percentage. */
export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Compact initials for a role chip, e.g. "DevOps Lead" → "DL".
 * Falls back to the first two characters for single-word roles.
 */
export function initials(role: string): string {
  const words = role.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
