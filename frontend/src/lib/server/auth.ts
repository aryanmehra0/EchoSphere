import { jwtVerify } from "jose";

import type { ParticipantRole, UserPermission, UserProfile } from "../types.ts";
import { DEV_PERSONAS, DEFAULT_USER, findPersonaById } from "../auth-personas.ts";

/*
  Read directly from `process.env` rather than importing `./env.ts`'s
  `serverEnv`: that module imports `server-only`, which throws when loaded
  outside a real Next.js bundler context (as this file is, by the plain
  Node test runner in `tests/roster-multiuser.test.ts`). `auth.ts` already
  reads headers/cookies inline rather than through a shared config module,
  so this matches its existing style.
*/
function jwtVerifySecret(): string | null {
  const v = process.env.JWT_VERIFY_SECRET?.trim();
  return v && v !== "" ? v : null;
}

function authGatewaySecret(): string | null {
  const v = process.env.AUTH_GATEWAY_SECRET?.trim();
  return v && v !== "" ? v : null;
}

/**
 * Decode and VERIFY a JWT's payload — never trust an unverified signature for
 * privilege. `JWT_VERIFY_SECRET` is unset by default, since no real IdP is
 * wired into this project; `getSessionUser` treats that as "this token
 * cannot be trusted" and falls through to the next identity source, rather
 * than granting a role/permission from claims nobody has checked.
 */
async function parseJwtPayload(token: string): Promise<Record<string, unknown> | null> {
  const secret = jwtVerifySecret();
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return payload as Record<string, unknown>;
  } catch {
    // Wrong secret, expired, malformed, wrong algorithm — all the same
    // outcome: this token does not establish who the caller is.
    return null;
  }
}

function mapCorporateRole(rolesOrGroups: string[]): ParticipantRole {
  const normalized = rolesOrGroups.map((r) => String(r).toLowerCase());
  if (normalized.some((r) => r.includes("commander") || r.includes("incident-lead"))) {
    return "Incident Commander";
  }
  if (normalized.some((r) => r.includes("sre-lead") || r.includes("devops") || r.includes("infra-lead"))) {
    return "DevOps Lead";
  }
  if (normalized.some((r) => r.includes("sre") || r.includes("reliability") || r.includes("platform"))) {
    return "Site Reliability Engineer";
  }
  if (normalized.some((r) => r.includes("db") || r.includes("database") || r.includes("dba") || r.includes("data"))) {
    return "Database Admin";
  }
  return "Observer";
}

function getPermissionsForRole(role: ParticipantRole): UserPermission[] {
  if (role === "Incident Commander") {
    return ["APPROVE_CRITICAL_ACTIONS", "MINT_TIMELINE_DECISIONS", "MANAGE_INCIDENT_STATE", "SPEAK_ON_BRIDGE"];
  }
  if (role === "DevOps Lead") {
    return ["APPROVE_CRITICAL_ACTIONS", "SPEAK_ON_BRIDGE", "MINT_TIMELINE_DECISIONS"];
  }
  if (role === "Site Reliability Engineer") {
    return ["SPEAK_ON_BRIDGE", "MINT_TIMELINE_DECISIONS"];
  }
  if (role === "Database Admin") {
    return ["SPEAK_ON_BRIDGE"];
  }
  return [];
}

/**
 * The identity an unauthenticated request resolves to outside development.
 *
 * `DEFAULT_USER` (below, dev-only) is Alice Chen — Incident Commander, full
 * permissions including `APPROVE_CRITICAL_ACTIONS`. Falling back to that for
 * a request presenting NO credentials at all would mean an anonymous caller
 * outside development gets treated as the most privileged persona in the
 * system. This is the safe floor instead: no identity, no authority.
 */
const SAFE_DEFAULT_USER: UserProfile = {
  id: "anonymous",
  name: "Unauthenticated",
  email: "",
  defaultRole: "Observer",
  permissions: [],
};

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * Extract authenticated user profile from an HTTP Request.
 *
 * Checks:
 * 1. `Authorization: Bearer <jwt>` (OIDC / SSO enterprise token) — trusted
 *    only when `JWT_VERIFY_SECRET` is configured and the signature verifies.
 * 2. `x-user-profile` HTTP header (JSON string or Base64 encoded JSON) —
 *    trusted only when `AUTH_GATEWAY_SECRET` is configured and the caller
 *    also presents a matching `x-gateway-secret` header, since otherwise
 *    this is just a client asserting its own identity.
 * 3. `x-echo-user-id` HTTP header / `echo_user_id` cookie → one of the fixed
 *    `DEV_PERSONAS` — development only.
 * 4. Fallback: `DEFAULT_USER` (a privileged dev persona) in development,
 *    `SAFE_DEFAULT_USER` (no identity, no permissions) otherwise.
 */
export async function getSessionUser(req: Request): Promise<UserProfile> {
  // 1. Enterprise OIDC / JWT Token — only when it can actually be verified.
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const claims = await parseJwtPayload(token);
    if (claims && typeof claims === "object") {
      const email = String(claims.email || claims.upn || "");
      const name = String(claims.name || claims.preferred_username || email.split("@")[0] || "Enterprise Engineer");
      const userId = String(claims.sub || claims.oid || email || `usr_${Date.now()}`);
      const rawGroups = (claims.groups || claims.roles || []) as string[];
      const defaultRole = mapCorporateRole(Array.isArray(rawGroups) ? rawGroups : [String(rawGroups)]);
      const permissions = getPermissionsForRole(defaultRole);

      return {
        id: userId,
        name,
        email,
        defaultRole,
        permissions,
      };
    }
  }

  // 2. Explicit User Profile Header (from API Gateway / Auth Proxy) — only
  // trusted alongside the shared secret that proves a real gateway set it.
  const gatewaySecret = authGatewaySecret();
  const profileHeader = req.headers.get("x-user-profile");
  if (profileHeader && gatewaySecret && req.headers.get("x-gateway-secret") === gatewaySecret) {
    try {
      let parsed: Record<string, unknown> | null = null;
      if (profileHeader.startsWith("{")) {
        parsed = JSON.parse(profileHeader) as Record<string, unknown>;
      } else {
        const decoded = Buffer.from(profileHeader, "base64").toString("utf-8");
        parsed = JSON.parse(decoded) as Record<string, unknown>;
      }
      if (parsed) {
        const email = String(parsed.email || "");
        const name = String(parsed.name || email.split("@")[0] || "Enterprise User");
        const userId = String(parsed.id || parsed.userId || email || `usr_${Date.now()}`);
        const role = (parsed.defaultRole || parsed.role || "Observer") as ParticipantRole;
        return {
          id: userId,
          name,
          email,
          defaultRole: role,
          permissions: getPermissionsForRole(role),
        };
      }
    } catch {
      // Fall through on bad profile header
    }
  }

  // 3. Fixed dev personas — never outside development. In production these
  // headers/cookies are just more unauthenticated client input.
  if (isDevelopment) {
    const headerUserId = req.headers.get("x-echo-user-id");
    if (headerUserId) {
      const matched = findPersonaById(headerUserId);
      if (matched) return matched;
    }

    const cookieHeader = req.headers.get("cookie") || "";
    const match = cookieHeader.match(/(?:^|;\s*)echo_user_id=([^;]+)/);
    if (match) {
      const cookieUserId = decodeURIComponent(match[1]);
      const matched = findPersonaById(cookieUserId);
      if (matched) return matched;
    }

    return DEFAULT_USER;
  }

  return SAFE_DEFAULT_USER;
}

export { DEV_PERSONAS, DEFAULT_USER, findPersonaById };

