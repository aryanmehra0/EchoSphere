import type { UserProfile } from "./types";

/**
 * Pre-configured enterprise personas for local development, Rehearsal Rig,
 * and multi-user evaluation.
 *
 * Each persona maps to an authenticated engineer with distinct organizational
 * authority and incident operational roles.
 */
export const DEV_PERSONAS: readonly UserProfile[] = [
  {
    id: "usr_alice",
    name: "Alice Chen",
    email: "alice@echosphere.dev",
    defaultRole: "Incident Commander",
    permissions: [
      "APPROVE_CRITICAL_ACTIONS",
      "MINT_TIMELINE_DECISIONS",
      "MANAGE_INCIDENT_STATE",
      "SPEAK_ON_BRIDGE",
    ],
  },
  {
    id: "usr_bob",
    name: "Bob Smith",
    email: "bob@echosphere.dev",
    defaultRole: "DevOps Lead",
    permissions: [
      "APPROVE_CRITICAL_ACTIONS",
      "MINT_TIMELINE_DECISIONS",
      "SPEAK_ON_BRIDGE",
    ],
  },
  {
    id: "usr_carol",
    name: "Carol Danvers",
    email: "carol@echosphere.dev",
    defaultRole: "Site Reliability Engineer",
    permissions: [
      "MINT_TIMELINE_DECISIONS",
      "SPEAK_ON_BRIDGE",
    ],
  },
  {
    id: "usr_david",
    name: "David Park",
    email: "david@echosphere.dev",
    defaultRole: "Database Admin",
    permissions: [
      "MINT_TIMELINE_DECISIONS",
      "SPEAK_ON_BRIDGE",
    ],
  },
  {
    id: "usr_elena",
    name: "Elena Rostova",
    email: "elena@echosphere.dev",
    defaultRole: "Observer",
    permissions: [],
  },
];

export const DEFAULT_USER: UserProfile = DEV_PERSONAS[0];

export function findPersonaById(id: string): UserProfile | undefined {
  return DEV_PERSONAS.find((p) => p.id === id);
}

