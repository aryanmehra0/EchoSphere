import { NextResponse } from "next/server";

import { credentialStatus } from "@/lib/server/env";
import { selectFastLoopModel } from "@/lib/server/groq-budget";

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
export async function GET(request: Request) {
  const credentials = credentialStatus();
  const missing = Object.entries(credentials)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  const ready = missing.length === 0;

  /*
    ── ?voice=1 — CAN ECHO ACTUALLY ANSWER? ─────────────────────────────────
    Presence of a key is not the same question as budget on that key, and the
    two came apart live: the pre-flight printed GO while Echo answered every
    spoken turn with Agora's `failure_message`.

    The reason is that the Slow Loop ROTATES across keys and the Fast Loop
    cannot — Agora's payload carries exactly one. So `/health/model` on the
    backend, which asks `groq_json`, answers "reachable on some key", while
    the question that matters here is "reachable on the key Agora will be
    given, with a reservation the size of a real turn".

    Off by default: it costs a Groq round trip per key, and most callers of
    this endpoint only want the credential list.
  */
  const wantsVoice = new URL(request.url).searchParams.get("voice") === "1";
  const fastLoop = wantsVoice ? await selectFastLoopModel() : null;

  return NextResponse.json(
    {
      ready,
      credentials,
      missing,
      ...(fastLoop
        ? {
            fastLoop: {
              model: fastLoop.model,
              keyIndex: fastLoop.keyIndex,
              voiceVerified: fastLoop.verified,
              ...(fastLoop.detail ? { detail: fastLoop.detail } : {}),
            },
          }
        : {}),
      ...(ready
        ? {}
        : { hint: "Copy .env.local.example to .env.local and fill it in." }),
    },
    { status: ready ? 200 : 503 },
  );
}
