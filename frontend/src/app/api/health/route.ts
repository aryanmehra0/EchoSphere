import { NextResponse } from "next/server";

import { credentialStatus } from "@/lib/server/env";

/**
 * GET /api/health — preflight for a live run.
 *
 * Reports WHICH credentials are configured, never their values. The point is to
 * turn "the bridge won't start and I don't know why" into a single curl before
 * anyone is on a call — the S0 spike and the demo rehearsal both start here.
 *
 * Returns 503 when anything required is missing so a CI check or a shell script
 * can gate on the status code rather than parsing the body.
 */
export async function GET() {
  const credentials = credentialStatus();
  const missing = Object.entries(credentials)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  const ready = missing.length === 0;

  return NextResponse.json(
    {
      ready,
      credentials,
      missing,
      ...(ready
        ? {}
        : { hint: "Copy .env.local.example to .env.local and fill it in." }),
    },
    { status: ready ? 200 : 503 },
  );
}
