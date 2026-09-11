"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useClock } from "@/hooks/useClock";

import {
  incidentReducer,
  initialIncidentState,
  type IncidentAction,
} from "./incident-reducer";
import { DEMO_SCRIPT, rebaseAction } from "./mock-stream";
import {
  beaconLeave,
  BridgeCredentialError,
  fetchRosterParticipants,
  heartbeatRoster,
  inviteAgent,
  openDeltaSocket,
  requestBridgeCredentials,
  slowLoopUrl,
  stopAgent,
  type DeltaSocket,
} from "./delta-socket";
import { AgoraBridge } from "./agora-bridge";
import type { IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import type { IncidentState, ParticipantRole, RosterParticipant } from "./types";

/**
 * Where the incident data on screen is coming from.
 *
 * Surfaced in the status bar rather than hidden, because an operator — or a
 * judge — must never be unsure whether they are watching a live bridge or a
 * rehearsal. Silently falling back to a scripted replay and letting someone
 * believe it is live would be its own kind of epistemic failure.
 */
export type DataSource = "live" | "replay" | null;

export interface BridgeJoinOptions {
  channel: string;
  role: ParticipantRole;
  userId?: string;
  name?: string;
  exclusive?: boolean;
}

/**
 * The console's state container.
 *
 * There is exactly one of these, mounted at the root of the client tree. Panels
 * subscribe to it rather than passing incident data down through props, because
 * the three columns need overlapping slices of the same state and prop-drilling
 * across a three-column console is how these dashboards rot.
 *
 * ── DATA SOURCES ─────────────────────────────────────────────────────────────
 * `openBridge()` opens the Slow Loop delta socket (v6 §9.3) and falls back to
 * the scripted replay if the Python service is unreachable. Both paths dispatch
 * the SAME `IncidentAction`s into the SAME reducer, so no component below this
 * file knows or cares which one is feeding it — that indifference is the entire
 * point of routing everything through one reducer, and it is what makes the
 * fallback in §17 ("the dashboard is the fallback demo") free rather than a
 * second code path to maintain.
 *
 * Still outstanding: the local RTC join, so the operator's own microphone
 * reaches the channel from this console rather than from `public/listen.html`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface IncidentStore {
  state: IncidentState;
  dispatch: (action: IncidentAction) => void;
  /** Monotonic clock for elapsed timers, ticking once per second. */
  now: number;
  openBridge: (options: BridgeJoinOptions) => void;
  closeBridge: () => void;
  micOn: boolean;
  toggleMic: () => void;
  /** live = Slow Loop socket, replay = scripted fallback, null = idle. */
  source: DataSource;
  /** Remote Echo track for the visual envelope, never incident data. */
  agentTrack: IRemoteAudioTrack | null;
  /** Selected graph entity for inspector overlay and ledger cross-filtering. */
  selectedEntityId: string | null;
  setSelectedEntityId: (id: string | null) => void;
  currentUid: number | null;
  currentRole: ParticipantRole | null;
  activeSpeakers: Set<number>;
  participants: RosterParticipant[];
  refreshParticipants: () => Promise<void>;
  postMortemOpen: boolean;
  setPostMortemOpen: (open: boolean) => void;
}

/**
 * Did the browser refuse the microphone because nobody granted it?
 *
 * Matched on the message rather than on `instanceof DOMException`, because by
 * the time it reaches us the SDK has usually re-wrapped it in its own
 * `AgoraRTCError` and the original prototype is gone. Both spellings are
 * checked: Agora's own `PERMISSION_DENIED` code and the DOM's
 * `NotAllowedError` name, which is what a bare `getUserMedia` rejection is
 * still called when the SDK passes it straight through.
 */
function isMicPermissionDenied(error: unknown): boolean {
  const text = [
    error instanceof Error ? error.name : "",
    error instanceof Error ? error.message : String(error),
    // AgoraRTCError carries the machine-readable reason here, not in `name`.
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "",
  ].join(" ");

  return /PERMISSION_DENIED|NotAllowedError|Permission denied|permission dismissed/i.test(
    text,
  );
}

const Ctx = createContext<IncidentStore | null>(null);

export function IncidentProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(incidentReducer, initialIncidentState);
  const [micOn, setMicOn] = useState(true);
  const [source, setSource] = useState<DataSource>(null);
  const [agentTrack, setAgentTrack] = useState<IRemoteAudioTrack | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [currentUid, setCurrentUid] = useState<number | null>(null);
  const [currentRole, setCurrentRole] = useState<ParticipantRole | null>(null);
  const [activeSpeakers, setActiveSpeakers] = useState<Set<number>>(new Set());
  const [participants, setParticipants] = useState<RosterParticipant[]>([]);
  const [postMortemOpen, setPostMortemOpen] = useState(false);

  /**
   * The latest state, readable from inside `openBridge`.
   *
   * `openBridge` is a `useCallback` that deliberately does not depend on
   * `state` - re-creating it on every delta would re-run the keyboard effect
   * in `BridgeControls` sixty times a minute. So reading `state` directly in
   * there closes over the value from the render that created the callback,
   * which during a long join is already stale. This ref is the read path.
   */
  const stateRef = useRef(state);
  // Written in an effect, not during render: mutating a ref while rendering is
  // unsafe under concurrent React (the render may be thrown away) and is
  // rejected by react-hooks/refs. An effect runs after commit, which is
  // exactly when "the latest committed state" becomes true.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** The live delta socket, when one is open. */
  const socket = useRef<DeltaSocket | null>(null);
  const agora = useRef<AgoraBridge | null>(null);
  /** The channel Echo was invited to, so leaving can stop the right agent. */
  const joinedChannel = useRef<string | null>(null);
  /**
   * The uid THIS tab joined as.
   *
   * Sent on leave so the server can release just this participant and keep
   * Echo running for anyone still on the bridge. Without it, the first person
   * to press Q stopped the Cloud Agent for everybody.
   */
  const joinedUid = useRef<number | null>(null);

  /**
   * A single shared 1Hz tick drives every elapsed timer in the console.
   * Individual components must not run their own intervals — a dozen unsynced
   * timers is both wasteful and visibly ragged when two counters disagree.
   * See `useClock` for why this is an external store rather than local state.
   */
  const now = useClock();

  /** Handles for the in-flight replay, so closing the bridge can cancel it. */
  const timers = useRef<number[]>([]);

  /**
   * A join already in flight, so a second one cannot start on top of it.
   *
   * ── WHY THIS IS NOT DEFENSIVE PROGRAMMING ───────────────────────────────
   * `openBridge` is reachable from the J key AND the button, neither of which
   * debounced. Pressing J twice, or clicking while the first join is still
   * negotiating, ran the whole sequence concurrently — and the second run
   * constructed a SECOND RTM client for the same uid before the first had
   * finished logging out. Agora says so directly:
   *
   *     <RTM> Ins id is 2, please pay attention to avoid mutual kick issues
   *
   * The two instances then kick each other. RTM is where the transcript feed
   * arrives (`data_channel: "rtm"`), so the loser stops receiving transcripts
   * entirely — which is the "it stops listening to the other person" that
   * looked like a timeout but never recovered, because nothing retries a
   * connection that believes it is still open.
   */
  const joining = useRef(false);

  const clearTimers = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => {
    const transport = new AgoraBridge({
      onAgentTrack: setAgentTrack,
      onAgentState: (agent) => dispatch({ type: "AGENT", state: agent }),
      onSpeakerVolumes: (volumes) => {
        const speaking = new Set<number>();
        for (const [uid, level] of volumes.entries()) {
          if (level >= 5) speaking.add(uid);
        }
        setActiveSpeakers(speaking);
      },
      /*
        ── ON SCREEN, NOT ONLY IN THE DEVTOOLS CONSOLE ─────────────────────
        This was `console.warn` alone, which meant the transport's loudest
        message — "NO TRANSCRIPTS — <reason>" — reached nobody. The operator
        saw an empty transcript panel and no explanation, and both times this
        failed for real it was diagnosed by reading Agora's REST history from
        a shell rather than by looking at the product.

        The degradation banner already exists for exactly this: one short line
        naming the CONSEQUENCE. Voice is marked degraded because that is what
        losing transcripts costs — the incident record, not the call.
      */
      onError: (detail) => {
        console.warn(`[agora bridge] ${detail}`);
        dispatch({
          type: "DELTA",
          payload: {
            degraded: {
              voice: true,
              extraction: false,
              model: null,
              banner: detail.slice(0, 140),
            },
          },
        });
      },

      /*
        ── EVIDENCE OUTRANKS A 45-SECOND-OLD SUSPICION ────────────────────
        The silence watchdog raises "NO TRANSCRIPT DATA" 45s after a join,
        which is long after `openBridge` — the only thing that ever lowered a
        banner — has returned. So the warning stayed on screen for the rest
        of the session, and it was reported over a bridge that was by then
        transcribing correctly: FRAMES 001, a turn rendered in the panel, and
        an alarm above it insisting the stream had carried nothing.

        An arriving transcript is direct proof of the opposite, so it clears
        the banner. Fires on every update, hence the guard: dispatching a
        no-op DELTA sixty times a minute would re-render the whole console
        for nothing.

        Deliberately narrow — it only clears a banner the transcript stream
        can actually disprove. A different failure (no RTM, a dead agent, a
        failed invite) has nothing to do with this evidence and must keep
        saying so.
      */
      onStreamAlive: () => {
        const banner = stateRef.current.degraded?.banner;
        if (!banner) return;
        if (!/NO TRANSCRIPT DATA|NO TRANSCRIPTS/i.test(banner)) return;
        dispatch({
          type: "DELTA",
          payload: {
            degraded: { voice: false, extraction: false, model: null, banner: null },
          },
        });
      },
    });
    agora.current = transport;

    return () => {
      void transport.leave();
      if (agora.current === transport) agora.current = null;
    };
  }, []);

  const refreshParticipants = useCallback(async () => {
    const ch = joinedChannel.current ?? "inc-4417";
    const next = await fetchRosterParticipants(ch);
    if (next && next.length > 0) {
      setParticipants(next);
    }
  }, []);

  // Sync roster participants periodically while on the voice bridge
  useEffect(() => {
    if (state.bridge !== "live") return;
    void refreshParticipants();
    const interval = window.setInterval(() => {
      void refreshParticipants();
    }, 4000);
    return () => window.clearInterval(interval);
  }, [state.bridge, refreshParticipants]);

  /**
   * The scripted replay — v6 §17's fallback demo.
   *
   * "Never let a change make the dashboard depend on the Fast Loop." The same
   * discipline applies to the Slow Loop: if the Python service is not running,
   * the console must still tell the whole story. This is that path, and it is
   * unchanged from Phase 1.
   */
  const startReplay = useCallback(() => {
    setSource("replay");

    const HANDSHAKE = 900;
    const epoch = Date.now() + HANDSHAKE;

    timers.current.push(
      window.setTimeout(() => {
        dispatch({ type: "BRIDGE", state: "live", at: epoch });
      }, HANDSHAKE),
    );

    for (const frame of DEMO_SCRIPT) {
      timers.current.push(
        window.setTimeout(
          // Rebased onto the real join time; the fixture stores offsets, and
          // the UI formats these as wall-clock times of day.
          () => dispatch(rebaseAction(frame.action, epoch)),
          HANDSHAKE + frame.at,
        ),
      );
    }
  }, []);

  const openBridge = useCallback(async ({ channel, role, userId, name, exclusive }: BridgeJoinOptions) => {
    const cleanChannel = channel.trim();
    if (!cleanChannel) return;

    // See `joining` above: a concurrent join creates a second RTM client for
    // the same uid, and the two kick each other off the transcript feed.
    if (joining.current) {
      console.info("[bridge] join already in progress — ignoring duplicate request");
      return;
    }
    joining.current = true;

    clearTimers();
    socket.current?.close();
    socket.current = null;
    /*
      ── TEARDOWN MUST NEVER STRAND THE JOIN FLAG ────────────────────────────
      This `await` sat between `joining.current = true` and the try/finally
      that releases it, so ANY throw from `leave()` escaped with the flag
      still set — and every subsequent press of J hit the guard, logged
      "join already in progress" to a console nobody has open, and did
      nothing. The Join button simply stopped working, permanently, with no
      error on screen and no way back short of a reload.

      Reported exactly that way. `leave()` is best-effort cleanup of a
      session that is being discarded anyway — a track that will not close or
      an SDK that is already torn down is not a reason to refuse the NEXT
      join. So it is contained here rather than being allowed to poison the
      flag.
    */
    try {
      await agora.current?.leave();
    } catch (error) {
      console.warn("[bridge] previous session did not tear down cleanly", error);
    }
    setAgentTrack(null);

    /*
      ── CLEAR THE BANNER BEFORE TRYING, NOT ONLY AFTER SUCCEEDING ──────────
      A previous failed join leaves "NO MICROPHONE — you can watch, but the
      room cannot hear you" on screen, and it was only lowered at the END of a
      SUCCESSFUL join. So a retry that worked still showed the old warning for
      its whole duration, and a retry that reached "Listening" while the banner
      stayed up produced a screen that contradicted itself: a red NO MICROPHONE
      bar directly above a live "Microphone open" control.

      An operator cannot act on a contradiction. Clear the stale verdict up
      front; this attempt will publish its own.
    */
    dispatch({
      type: "DELTA",
      payload: {
        degraded: { voice: false, extraction: false, model: null, banner: null },
      },
    });
    setMicOn(true);
    dispatch({ type: "RESET" });
    dispatch({ type: "BRIDGE", state: "connecting" });

    /**
     * Try the Slow Loop first, fall back to the replay.
     *
     * The component tree cannot tell the difference — both paths dispatch the
     * same `IncidentAction`s into the same reducer, which is the entire point
     * of routing everything through one reducer. Only the status bar knows,
     * because an operator deserves to know whether they are looking at a live
     * incident or a rehearsal.
     */
    /*
      ORDER MATTERS: evidence path first, microphone second.

      §17's standing rule is "never let a change make the dashboard depend on
      the Fast Loop", and joining Agora before opening the delta socket breaks
      exactly that. A denied microphone permission, a stale token, a laptop with
      no input device — any of those would have taken the LIVE DASHBOARD down
      with them, even though the Slow Loop was healthy and everyone else's
      speech was still being transcribed and analysed.

      So the socket opens first and the dashboard is live regardless. The RTC
      join is then attempted, and if it fails we lose only this operator's
      microphone: they can still watch a real incident unfold, and the console
      says which capability was lost rather than silently pretending.
    */
    socket.current = openDeltaSocket({
      url: slowLoopUrl(),
      dispatch,
      onStatus: (s) => {
        if (s === "live") {
          setSource("live");
          dispatch({ type: "BRIDGE", state: "live", at: Date.now() });
        }
      },
      onUnavailable: () => {
        socket.current = null;

        /*
          ── THE REHEARSAL IS NOW OPT-IN ────────────────────────────────────
          This used to call `startReplay()` unconditionally, and that is a
          bad trade outside a demo.

          The replay injects a COMPLETE FABRICATED INCIDENT - claims about
          Redis evicting keys, a checkout service, entities, a contradiction -
          and it renders through the same reducer as real analysis, so it is
          indistinguishable from the product working. The only tell is one
          small "Rehearsal" chip in the status bar.

          It fired whenever the delta socket could not be reached, which on a
          shared tunnel is EVERY guest: the console tunnel does not proxy
          /ws/deltas, so the socket always gives up and every guest watched a
          Ledger fill itself with fiction about an outage that never happened.
          Reported as "it starts auto filling the ledger, I don't want them".

          Inventing incident data is the exact failure this product exists to
          prevent. It must never be the automatic response to a network
          problem - a Ledger that stays empty is honest, and the banner below
          says why it is empty.

          Set NEXT_PUBLIC_DEMO_REPLAY=1 to get the scripted rehearsal back for
          a demo on a machine with no backend.
        */
        const replayAllowed = process.env.NEXT_PUBLIC_DEMO_REPLAY === "1";

        if (replayAllowed) {
          // A live microphone with no evidence path is misleading — speech
          // would reach the channel and nothing would record it. Only the
          // replay needs this, because only the replay takes the dashboard
          // over; a real bridge with no Slow Loop keeps its microphone.
          void agora.current?.leave();
          setAgentTrack(null);
          console.info("[bridge] Slow Loop unreachable — running the scripted rehearsal (NEXT_PUBLIC_DEMO_REPLAY=1)");
          startReplay();
          return;
        }

        /*
          Say what is missing and leave the record alone. The voice bridge is
          untouched - people can still talk, and Echo still answers - so this
          is a degraded console, not a dead one.
        */
        console.warn(
          `[bridge] Slow Loop unreachable at ${slowLoopUrl()} — the Ledger will stay empty. ` +
            "Set NEXT_PUBLIC_DEMO_REPLAY=1 for the scripted rehearsal.",
        );
        dispatch({
          type: "DELTA",
          payload: {
            degraded: {
              voice: false,
              extraction: true,
              model: null,
              banner:
                "NO ANALYSIS — the Slow Loop is unreachable, so nothing spoken is being recorded",
            },
          },
        });
      },
    });

    /*
      PUT ECHO IN THE CHANNEL — v6 W1.

      Deliberately NOT awaited before the join, and deliberately not allowed to
      throw into it. Inviting a Cloud Agent is a round trip to Agora that can
      take seconds or fail outright on a bad TTS key; §17 says the dashboard
      must never depend on the Fast Loop, and that includes not waiting on it.

      This call was missing entirely until Aug 31. Every other link worked —
      tokens minted, RTC joined, claims extracted, contradictions detected —
      and Echo was never in the room to say any of it. Nothing errored. It was
      simply silent, which is the hardest kind of bug to see.
    */
    joinedChannel.current = cleanChannel;

    /*
      ORDER: credentials FIRST, because this browser needs its own UID before
      it can join RTC or label the speech it forwards.

      Echo itself now subscribes to `["*"]` — every participant in the channel,
      per Agora's documented wildcard — so the invite no longer decides who
      Echo can hear. It passes this UID for the Roster and the audit trail, not
      to pick a single listener. (An earlier comment here claimed `"*"` was not
      a wildcard and that the agent had to be told which one person to hear.
      That was wrong, and it made Echo deaf to everyone but the first joiner —
      see agent-config.ts and session_log §7.)

      §17 still holds. The dashboard is already live by this point — the delta
      socket opened above — so neither of these calls can take it down, and the
      invite remains unawaited so a slow Agora cannot stall the join.
    */
    /*
      ── IDENTITY FIRST, AND IN ITS OWN TRY ──────────────────────────────────
      This call used to sit INSIDE the try that wraps the RTC join, so every
      way it can fail printed "NO MICROPHONE - you can watch, but the room
      cannot hear you". That banner was wrong in the most expensive way
      available: it named a component nothing had touched yet.

      The failure it hid is the ordinary one for a SECOND participant. The role
      dropdown defaults to "DevOps Lead" in every browser, roles are exclusive
      per bridge (deliberately - see /api/token), so person two presses J, gets
      a 409, and is told their microphone is not allowed. Person one is fine,
      which is exactly the "works for one person, not for several" report: the
      first joiner takes the default role and everybody after them collides
      with it.

      Two consequences, both fixed here. The banner now names the real fault
      and repeats the server's list of free roles, so the fix ("pick Support
      Engineer") is on screen instead of in a DevTools network tab. And a
      credential failure returns early rather than falling through to the RTC
      teardown path, because there is no session to tear down.
    */
    let credentials: Awaited<ReturnType<typeof requestBridgeCredentials>>;
    try {
      credentials = await requestBridgeCredentials(cleanChannel, role, {
        userId,
        name,
        exclusive,
      });
      setCurrentUid(credentials.uid);
      setCurrentRole(credentials.role);
    } catch (error) {
      const conflict = error instanceof BridgeCredentialError && error.isRoleConflict;
      const detail = error instanceof Error ? error.message : String(error);
      const free =
        error instanceof BridgeCredentialError && error.availableRoles.length
          ? ` Free now: ${error.availableRoles.join(", ")}.`
          : "";

      console.warn("[bridge] no credentials were issued — not joining", error);
      dispatch({
        type: "DELTA",
        payload: {
          degraded: {
            voice: true,
            extraction: false,
            model: null,
            banner: conflict
              ? `ROLE ALREADY TAKEN — pick a different role and press J again.${free}`
              : `NOT ADMITTED TO THE BRIDGE — ${detail}`,
          },
        },
      });
      joining.current = false;
      return;
    }

    try {
      // Remembered for `closeBridge`, so leaving releases THIS participant
      // rather than stopping Echo for the whole room.
      joinedUid.current = credentials.uid;

      void inviteAgent(cleanChannel, credentials.uid)
        .then(({ agentId, registeredWithSlowLoop, toolsEnabled }) => {
          if (!agentId) {
            console.warn("[bridge] Agora accepted the invite but returned no agent id");
            return;
          }
          console.info(
            `[bridge] Echo joined as ${agentId}, listening to uid ${credentials.uid}` +
              `${toolsEnabled ? " with Ledger tools" : " WITHOUT tools"}`,
          );
          /*
            ── "WITHOUT tools" BELONGS ON SCREEN, NOT IN console.info ───────
            Reported live: the Support Engineer said "Database is down", the
            Ledger filed it correctly under Support Engineer, and Echo
            answered "who reported that?" by saying it was not associated
            with any person or role.

            The cause was that AGENT_TOOL_BASE_URL was empty, so
            `buildToolsBlock` returned `{}` and the agent was created with NO
            TOOLS — it could not read the Ledger at all. The only evidence
            was this line in `console.info`, which nobody has open during a
            demo.

            From the room that is indistinguishable from Echo evading the
            question, and it invites exactly the wrong diagnosis: people go
            looking for a broken attribution pipeline when attribution is
            fine and the tunnel is simply missing. So it is said out loud.

            Not `voice: true` — Echo can hear and speak perfectly. Only the
            READ capability is missing, and the banner says which.
          */
          if (!toolsEnabled) {
            dispatch({
              type: "DELTA",
              payload: {
                degraded: {
                  voice: false,
                  extraction: false,
                  model: null,
                  banner:
                    "ECHO CANNOT READ THE LEDGER — no tunnel, so it cannot " +
                    "answer who said what. Restart with: .\\start.ps1 -Tunnel",
                },
              },
            });
          }

          if (!registeredWithSlowLoop) {
            // Echo is audible but will never speak ABOUT the incident. That
            // distinction is impossible to work out from inside the room, so
            // it gets said out loud rather than discovered on stage.
            dispatch({
              type: "DELTA",
              payload: {
                degraded: {
                  voice: true,
                  extraction: false,
                  model: null,
                  banner: "ECHO CANNOT SPEAK — the Slow Loop never received the agent id",
                },
              },
            });
          }
        })
        .catch((error) => {
          console.warn("[bridge] agent invite failed — dashboard is unaffected", error);
          dispatch({
            type: "DELTA",
            payload: {
              degraded: {
                voice: true,
                extraction: false,
                model: null,
                banner: "NO VOICE — Echo could not join the bridge",
              },
            },
          });
        });

      await agora.current?.join(cleanChannel, credentials);

      /*
        ── AN RTC JOIN IS ALSO "LIVE", NOT ONLY THE DELTA SOCKET ─────────────
        `BRIDGE live` was dispatched from ONE place: the delta socket's
        `onStatus`. So the transport that carries the operator's voice could be
        fully established - joined, microphone published, Echo subscribed and
        answering out loud - and the console still read "Connecting to bridge",
        because the only thing allowed to end that state was a WebSocket to the
        Slow Loop.

        On a shared tunnel that socket may never open at all (the console
        tunnel does not proxy /ws/deltas), and the result was a screen that
        contradicted the room: microphone live in the address bar, Echo
        "Listening", and a button spinning on "Connecting" forever.

        The bridge IS live at this point by the only definition the label
        claims - this console is on the voice bridge. `source` still says
        whether the evidence path is live or a replay, and the degradation
        banner still says what is missing, so nothing here overstates the
        state; it stops understating it.

        Guarded so it cannot walk backwards out of `closing`.
      */
      if (stateRef.current.bridge !== "closing") {
        dispatch({ type: "BRIDGE", state: "live", at: Date.now() });
      }

      /*
        ── A SUCCESSFUL JOIN CLEARS THE BANNER ────────────────────────────────
        Nothing else ever did. `onError` raises the degradation banner and no
        path lowered it, so any transient failure — a lost subscribe race, a
        tunnel blip, an invite that succeeded on retry — left "NO VOICE" on
        screen permanently over a bridge that was working perfectly.

        A banner that cannot clear itself stops being information and becomes
        noise people learn to ignore, which is worse than not having one: the
        NEXT genuine failure is the one nobody looks at. So reaching the end of
        a join with no throw is treated as the positive evidence it is.
      */
      dispatch({
        type: "DELTA",
        payload: {
          degraded: { voice: false, extraction: false, model: null, banner: null },
        },
      });
    } catch (error) {
      // Voice is gone; the incident record is not. This is the ANALYTICS-ONLY
      // rung of §13's ladder, and the operator is told rather than left to
      // wonder why nobody can hear them.
      console.warn("[bridge] RTC join failed — continuing without a microphone", error);
      await agora.current?.leave();
      setAgentTrack(null);
      dispatch({
        type: "DELTA",
        payload: {
          degraded: {
            voice: true,
            extraction: false,
            model: null,
            /*
              Everything reaching here IS a genuine media/RTC failure now that
              credentials are handled above — but "no microphone" still covers
              two different faults with two different fixes, and the operator
              is the only one who can apply either.

              A DENIED PERMISSION is recoverable in five seconds from the
              browser's address bar, and it is by far the most common one on a
              second machine: the guest sees Chrome's prompt, misses it or
              dismisses it, and the console then said only that the room could
              not hear them. Agora surfaces this as PERMISSION_DENIED and the
              underlying DOMException as NotAllowedError; either spelling means
              "the person must say yes", so both are named explicitly.

              Anything else - no input device at all, a track the browser
              refused for another reason, a channel it could not reach - keeps
              the original wording, which is accurate for those.
            */
            banner: isMicPermissionDenied(error)
              ? "MICROPHONE BLOCKED — allow microphone access for this site, then press J again"
              : "NO MICROPHONE — you can watch, but the room cannot hear you",
          },
        },
      });
    } finally {
      // Released on EVERY path — success, throw, or the degraded fallback.
      // A flag left set would block every future join with no way back.
      joining.current = false;
    }
  }, [clearTimers, startReplay]);

  const closeBridge = useCallback(() => {
    clearTimers();
    socket.current?.close();
    socket.current = null;
    void agora.current?.leave();
    // Leaving RTC does NOT stop the Cloud Agent — it is a separate process
    // that keeps running, and billing, until Agora times it out. Rehearsing
    // ten times without this leaves ten Echoes in the channel.
    if (joinedChannel.current) {
      // WITH our uid: the route releases this participant and stops the agent
      // only when the bridge is empty. On a three-person call the first
      // person to leave used to silence Echo for the other two.
      void stopAgent(joinedChannel.current, joinedUid.current ?? undefined);
      joinedChannel.current = null;
      joinedUid.current = null;
    }
    setAgentTrack(null);
    setMicOn(true);
    setSource(null);
    setSelectedEntityId(null);
    setCurrentUid(null);
    setCurrentRole(null);
    dispatch({ type: "BRIDGE", state: "closing" });
    timers.current.push(
      window.setTimeout(() => dispatch({ type: "RESET" }), 400),
    );
  }, [clearTimers]);

  useEffect(() => {
    return () => {
      clearTimers();
      socket.current?.close();
      void agora.current?.leave();
      // Same occupancy rule as `closeBridge`: a tab closing is one
      // participant leaving, not the end of the bridge.
      if (joinedChannel.current) {
        void stopAgent(joinedChannel.current, joinedUid.current ?? undefined);
      }
    };
  }, [clearTimers]);

  /*
    ── RELEASE THE ROLE WHEN THE PAGE GOES AWAY, NOT JUST WHEN REACT UNMOUNTS ─
    The cleanup above only runs on an orderly React unmount. It does NOT run
    on a hard refresh, a closed tab, a closed laptop or a crash - and those
    are exactly the cases that were leaving GHOSTS in the roster.

    Reported live: one person joined as DevOps Lead and the second could not
    select any role at all, because the roster listed all three as held while
    only one human was present. Roster rows are only released by an orderly
    leave and otherwise live for the full token TTL, so each abandoned session
    locked a role for an hour.

    `pagehide` is the reliable signal here - `beforeunload` is unreliable on
    mobile and `unload` never fires when a page enters the back/forward cache.
    `sendBeacon` is the only thing that survives teardown: a `fetch` issued
    during unload is cancelled with the document, which is why the cleanup
    above could never have covered this.

    Best effort by design. It cannot be awaited and it can be lost, so the
    server-side takeover in `/api/token` remains the real guarantee - this
    just makes the common case clean rather than relying on the fallback.
  */
  useEffect(() => {
    const release = () => {
      const channel = joinedChannel.current;
      const uid = joinedUid.current;
      if (!channel || uid === null) return;
      // The beacon itself lives in `delta-socket.ts`: Zone 1 egress is
      // confined to that module by `phase1-evaluation.test.ts`, and calling
      // the browser's beacon API directly from here is exactly the
      // unreviewed egress path that test exists to catch. It caught this one.
      beaconLeave(channel, uid);
    };

    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, []);

  /*
    ── PROVE THIS PARTICIPANT IS STILL HERE ────────────────────────────────
    A roster row records who JOINED, and nothing refreshed it — `touchExpiry`
    is only ever called for the agent. So a row could not distinguish someone
    mid-sentence from someone whose laptop closed twenty minutes ago, and
    since only an orderly leave releases one, an abandoned row held its role
    for the full hour.

    That is what locked the bridge: one person joined as DevOps Lead, the
    roster still listed all three roles from earlier sessions, and the second
    joiner could not select anything.

    `/api/token` reclaims a role unseen for 90s. This is what makes "seen"
    mean something, and it is why that takeover cannot evict a live
    participant: 30s is comfortably inside the window, so a real person is
    always fresh and a ghost is always stale.

    Only runs while actually joined, and it never touches incident state.
  */
  useEffect(() => {
    if (state.bridge !== "live") return;

    const beat = () => {
      const channel = joinedChannel.current;
      const uid = joinedUid.current;
      if (!channel || uid === null) return;
      void heartbeatRoster(channel, uid);
    };

    beat();
    const timer = window.setInterval(beat, 30_000);
    return () => window.clearInterval(timer);
  }, [state.bridge]);

  /*
    ── THE BUTTON MUST NEVER CLAIM A MUTE THAT DID NOT HAPPEN ──────────────
    `setMicOn` used to live only inside `.then()`, so if `setEnabled` rejected
    the track stayed live while the UI kept its previous label — and the
    failure was reported to `console.warn`, which nobody has open. Someone
    pressing M, seeing nothing change, and pressing it again could end up
    muted-on-screen and hot on the bridge, or the reverse.

    On a product about faithful records, a mute control that can lie is worse
    than one that occasionally refuses. So the state is set from the ACTUAL
    outcome: on success it moves, and on failure it is forced back to the
    truth (still live) and said out loud rather than logged.
  */
  const toggleMic = useCallback(() => {
    const next = !micOn;
    const bridge = agora.current;
    if (!bridge) return;

    void bridge
      .setMuted(!next)
      .then(() => setMicOn(next))
      .catch((error) => {
        console.warn("[bridge] microphone update failed", error);
        // The track did not change, so neither does the label.
        setMicOn(!next);
        dispatch({
          type: "DELTA",
          payload: {
            degraded: {
              voice: false,
              extraction: false,
              model: null,
              banner: next
                ? "MICROPHONE DID NOT UNMUTE — the bridge cannot hear you"
                : "MICROPHONE DID NOT MUTE — you are still live on the bridge",
            },
          },
        });
      });
  }, [micOn]);

  const value = useMemo<IncidentStore>(
    () => ({
      state,
      dispatch,
      now,
      openBridge,
      closeBridge,
      micOn,
      toggleMic,
      source,
      agentTrack,
      selectedEntityId,
      setSelectedEntityId,
      currentUid,
      currentRole,
      activeSpeakers,
      participants,
      refreshParticipants,
      postMortemOpen,
      setPostMortemOpen,
    }),
    [
      state,
      now,
      openBridge,
      closeBridge,
      micOn,
      toggleMic,
      source,
      agentTrack,
      selectedEntityId,
      currentUid,
      currentRole,
      activeSpeakers,
      participants,
      refreshParticipants,
      postMortemOpen,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useIncident(): IncidentStore {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useIncident must be used inside <IncidentProvider>");
  }
  return ctx;
}
