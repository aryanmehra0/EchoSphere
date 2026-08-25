import "server-only";

import { RtcRole, RtcTokenBuilder, RtmTokenBuilder } from "agora-token";

import { serverEnv } from "./env";

/**
 * Agora token minting — Zone 2 only (v6 §10.1).
 *
 * The app certificate never leaves this process. What reaches the browser is a
 * short-TTL token scoped to one channel and one UID, which is the entire
 * reason a frontend compromise has a blast radius of "can talk on one bridge
 * for under an hour" rather than "can mint credentials".
 */

/**
 * One hour, matching Agora's default.
 *
 * v6 W7 is explicit that BOTH long-lived members renew — the agent and the
 * Observer. v5 covered only the agent, so the Observer would silently drop out
 * around the one-hour mark, taking the whole dashboard with it. That is exactly
 * when a real Sev-1 is at its most active, which is the worst possible moment
 * to discover it.
 */
export const TOKEN_TTL_SECONDS = 3600;

/** Renew this far ahead of expiry, per W7's T-minus-300s rule. */
export const RENEW_MARGIN_SECONDS = 300;

export interface MintedTokens {
  rtcToken: string;
  rtmToken: string;
  uid: number;
  channel: string;
  /** Epoch ms. The client schedules its own renewal from this. */
  expiresAt: number;
}

/**
 * Mint an RTC + RTM pair for one participant.
 *
 * `publisher` is false for the Observer: it joins to LISTEN, and a headless
 * worker that can publish audio is a worker that can be made to talk. Least
 * privilege at the token level costs nothing and removes the possibility.
 */
export function mintTokens(
  channel: string,
  uid: number,
  { publisher = true }: { publisher?: boolean } = {},
): MintedTokens {
  const appId = serverEnv.agoraAppId;
  const appCertificate = serverEnv.agoraAppCertificate;

  const now = Math.floor(Date.now() / 1000);
  const privilegeExpire = now + TOKEN_TTL_SECONDS;

  const rtcToken = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channel,
    uid,
    publisher ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
    TOKEN_TTL_SECONDS,
    privilegeExpire,
  );

  // RTM identifies by string account, so the UID is stringified. Keeping it
  // numerically identical to the RTC uid is what lets a transcript frame from
  // RTM be joined to a roster entry keyed by RTC uid without a lookup table.
  const rtmToken = RtmTokenBuilder.buildToken(
    appId,
    appCertificate,
    String(uid),
    TOKEN_TTL_SECONDS,
  );

  return {
    rtcToken,
    rtmToken,
    uid,
    channel,
    expiresAt: (now + TOKEN_TTL_SECONDS) * 1000,
  };
}

/**
 * Basic auth header for the Conversational AI REST API.
 *
 * Agora authenticates the management API with a Customer ID / Secret pair,
 * which is a DIFFERENT credential from the app certificate used for tokens.
 * Conflating them is a common and confusing failure, so they are separate
 * accessors on `serverEnv` and separate variables in `.env.local`.
 */
export function agoraAuthHeader(): string {
  const raw = `${serverEnv.agoraCustomerId}:${serverEnv.agoraCustomerSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}
