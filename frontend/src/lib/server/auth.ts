import type { UserProfile } from "../types.ts";
import { DEV_PERSONAS, DEFAULT_USER, findPersonaById } from "../auth-personas.ts";

/**
 * Extract authenticated user profile from an HTTP Request.
 *
 * Checks:
 * 1. `x-echo-user-id` HTTP header (injected by proxy, gateway, or API caller)
 * 2. `echo_user_id` Cookie header
 * 3. Fallback to DEFAULT_USER in development/rehearsal mode
 */
export async function getSessionUser(req: Request): Promise<UserProfile> {
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

export { DEV_PERSONAS, DEFAULT_USER, findPersonaById };

