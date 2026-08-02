// The channel-agnostic half of notifications: what happened, not how to say it.
//
// The bridge already emits everything needed — server messages and its own log
// stream — so this layer subscribes rather than instruments. Nothing here knows
// about Telegram; a future Bark or Server酱 channel implements NotifyChannel and
// inherits the same event catalogue and the same throttling.
//
// Hard rule: no path in here may throw into the bridge. A notification that
// fails is a notification lost, never a match lost.

import type { BridgeDecisionTrace } from "../bridge/provider";
import { fullReplayURL, resultLabel } from "../bridge/runner";
import type { MsgGameOver } from "../protocol/types";
import type { ServerMessageEnvelope } from "../wsclient/frame-handler";
import { sameOriginUrl } from "./safe-url";

export type NotifyEvent =
  | {
      readonly kind: "match.result";
      readonly game?: string;
      /** resultLabel() wording: "1st place" | "forfeit" | "draw" | … */
      readonly selfLabel: string;
      readonly won: boolean;
      readonly draw: boolean;
      readonly forfeitedSelf: boolean;
      readonly forfeitReason?: string;
      readonly opponents: readonly string[];
      /** Absent for forfeits — the server does not publish those replays. */
      readonly replayUrl?: string;
      readonly playerCount: number;
      readonly matchId: string;
      /** game_start → game_over on this machine's clock. Absent when the
       *  bridge did not see the start (reconnect mid-match). */
      readonly durationMs?: number;
      /**
       * The rating line, filled in AFTER the fact by the Telegram channel's
       * enrichment step (notify/telegram/match-report.ts) — the protocol does
       * not carry per-match rating changes, so this is the public profile
       * diffed against a local snapshot. Absent when the lookup failed; the
       * report then simply has no rating line.
       */
      readonly rating?: {
        readonly game: string;
        /** display_rating — the number every other surface shows. */
        readonly rating: number;
        /** vs the snapshot taken after the previous match. */
        readonly delta?: number;
        /** Leaderboard position, when the agent is on the board. */
        readonly rank?: number;
        /** Positive = climbed that many places since the snapshot. */
        readonly rankDelta?: number;
      };
    }
  | {
      readonly kind: "digest.daily";
      readonly date: string;
      /** Set when this report covers materially more than a day (the bridge was
       *  off, so the previous digest is older than yesterday). Everything in the
       *  message then describes that longer window, and says so. */
      readonly since?: string;
      readonly played: number;
      readonly wins: number;
      readonly losses: number;
      readonly draws: number;
      readonly byGame: readonly { readonly game: string; readonly played: number; readonly wins: number }[];
      readonly bestReplayUrl?: string;
      readonly costText?: string;
      readonly gamesTodayServer?: number;
      readonly ratingDeltas?: readonly { readonly game: string; readonly delta: number }[];
    }
  | {
      readonly kind: "alert.llm_failure";
      readonly matchId: string;
      readonly game?: string;
      /**
       * What actually happened to the turn. The two are NOT the same event and
       * used to share one (wrong) sentence:
       *  - "fallback_action": the model call failed and the bridge played its
       *    own deterministic move. This is the common one — an expired key, an
       *    exhausted quota — and it never throws, so it is only visible on the
       *    decision trace, not in the log stream.
       *  - "no_action": deciding threw outright, so nothing was sent at all and
       *    the turn runs down its clock toward a strike.
       */
      readonly degraded: "fallback_action" | "no_action";
      readonly reasonSummary: string;
    }
  | { readonly kind: "alert.disconnected"; readonly sinceMs: number }
  | {
      readonly kind: "alert.recovered";
      /** How long the just-ended outage lasted, for the message text. */
      readonly offlineMs: number;
    }
  | { readonly kind: "alert.forfeit"; readonly game?: string; readonly reason?: string; readonly matchId: string }
  | {
      readonly kind: "alert.fatal";
      readonly code: "device_mismatch" | "client_mismatch" | "credential_rejected" | "bridge_stopped";
      readonly message: string;
    }
  | {
      readonly kind: "challenge.accepted";
      readonly game: string;
      /** Who took it, when the server names them. */
      readonly guestName?: string;
    };

export interface NotifyChannel {
  /** MUST return immediately — the caller is the bridge's own message loop.
   *  Delivery happens in the background and its failures stay inside. */
  deliver(event: NotifyEvent): void;
  /** Bounded flush; must resolve even if the network is gone. */
  stop(): Promise<void>;
}

export interface BridgeLogEvent {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

export interface BridgeNotifier {
  observeServerMessage(message: ServerMessageEnvelope): void;
  observeLog(event: BridgeLogEvent): void;
  /** The decision trace, which is where a failed model call actually shows up:
   *  the provider substitutes a fallback move and returns normally, so nothing
   *  reaches the log stream. */
  observeTrace(trace: BridgeDecisionTrace): void;
  stop(): Promise<void>;
}

export interface BridgeNotifierOptions {
  readonly agentId: string;
  readonly baseUrl: string;
  readonly channel: NotifyChannel;
  readonly now?: () => number;
}

/** Repeat window for "the model call failed" on one match. Long enough that a
 *  wedged provider does not turn into a phone alarm; short enough that a new
 *  match with the same problem still says so. */
const LLM_FAILURE_THROTTLE_MS = 10 * 60_000;

/** Longest reason text carried into a notification. */
const REASON_MAX_CHARS = 200;

/** How many in-flight matches to remember a game name for. A bridge plays a
 *  handful at once; this only exists so a long uptime cannot grow a map. */
const SESSION_GAME_LIMIT = 64;

export function createBridgeNotifier(opts: BridgeNotifierOptions): BridgeNotifier {
  const now = opts.now ?? Date.now;
  /** session_id → {game, startedAt}, learned from game_start (game_over does
   *  not repeat the game, and the duration is this machine's own clock). */
  const sessionGames = new Map<string, { game: string; startedAt: number }>();
  const llmFailureAt = new Map<string, number>();
  /** Why the last model call for a match failed, so the alert can say more than
   *  "it failed" — the provider's own classification (auth / quota / …). */
  const lastRuntimeFailure = new Map<string, string>();
  /** One "you are offline" message per outage, not one per retry — and the
   *  timestamp of that message, so a reconnect can close the loop with a
   *  "back online" note instead of leaving the phone on the bad news. */
  let disconnectAlertedAt: number | null = null;

  function emit(event: NotifyEvent): void {
    try {
      opts.channel.deliver(event);
    } catch {
      // deliver() is documented as non-throwing; if a channel breaks that
      // contract it still must not reach the bridge.
    }
  }

  function rememberGame(sessionId: string, game: string): void {
    if (sessionGames.size >= SESSION_GAME_LIMIT) {
      const oldest = sessionGames.keys().next();
      if (!oldest.done) sessionGames.delete(oldest.value);
    }
    sessionGames.set(sessionId, { game, startedAt: now() });
  }

  /** Remember something per match without letting the map grow forever. */
  function remember<T>(map: Map<string, T>, key: string, value: T): void {
    if (map.size >= SESSION_GAME_LIMIT && !map.has(key)) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    map.set(key, value);
  }

  /** One alert per match per throttle window, whichever way the turn degraded. */
  function emitLlmFailure(
    matchId: string,
    degraded: "fallback_action" | "no_action",
    reasonSummary: string,
  ): void {
    const last = llmFailureAt.get(matchId);
    if (last !== undefined && now() - last < LLM_FAILURE_THROTTLE_MS) return;
    remember(llmFailureAt, matchId, now());
    const game = sessionGames.get(matchId)?.game;
    emit({
      kind: "alert.llm_failure",
      matchId,
      degraded,
      ...(game !== undefined ? { game } : {}),
      reasonSummary: truncate(reasonSummary),
    });
  }

  function onGameOver(gameOver: MsgGameOver): void {
    const data = gameOver.data;
    const self = data.players.find((p) => p.agent_id === opts.agentId);
    const started = sessionGames.get(data.session_id);
    const game = started?.game;
    const durationMs = started === undefined ? undefined : Math.max(0, now() - started.startedAt);
    sessionGames.delete(data.session_id);

    const label = resultLabel(opts.agentId, gameOver);
    const forfeitedSelf = self !== undefined && data.forfeited_by === self.player_id;
    // Same-origin only: this becomes a button in the user's own chat, and an
    // absolute replay_url from the server would otherwise override the base.
    const replayUrl = sameOriginUrl(opts.baseUrl, fullReplayURL(opts.baseUrl, data.replay_url));

    emit({
      kind: "match.result",
      ...(game !== undefined ? { game } : {}),
      selfLabel: label,
      won: label === "1st place",
      draw: data.result.is_draw === true,
      forfeitedSelf,
      ...(data.forfeit_reason !== undefined ? { forfeitReason: truncate(data.forfeit_reason) } : {}),
      opponents: data.players.filter((p) => p.agent_id !== opts.agentId).map((p) => p.agent_name),
      ...(replayUrl !== undefined ? { replayUrl } : {}),
      playerCount: data.players.length,
      matchId: data.match_id,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });

    // Losing by forfeit is worth its own alert: it means the agent stopped
    // answering, which the ordinary result line understates.
    if (forfeitedSelf) {
      emit({
        kind: "alert.forfeit",
        ...(game !== undefined ? { game } : {}),
        ...(data.forfeit_reason !== undefined ? { reason: truncate(data.forfeit_reason) } : {}),
        matchId: data.match_id,
      });
    }
  }

  return {
    observeServerMessage: (message) => {
      try {
        if (message.type === "game_start") {
          const data = message.data as { match_id?: unknown; game?: unknown };
          if (typeof data?.match_id === "string" && typeof data.game === "string") {
            rememberGame(data.match_id, data.game);
          }
          return;
        }
        if (message.type !== "game_over") return;
        if (!isGameOverData(message.data)) return;
        onGameOver({ type: "game_over", data: message.data } as MsgGameOver);
      } catch {
        // Never let a malformed message reach the bridge's message loop.
      }
    },

    observeLog: (event) => {
      try {
        switch (event.code) {
          case "bridge.fallback_required": {
            // The rarer half: deciding threw, so NOTHING was sent for the turn.
            const matchId = /match ([\w.:-]+)/.exec(event.message)?.[1] ?? "unknown";
            emitLlmFailure(matchId, "no_action", event.message);
            return;
          }
          case "reconnect.attempt_failure": {
            // The 15-minute judgement already happened: the reconnect layer
            // raises severity to "error" once an outage passes that mark, so
            // there is no second timer to keep here.
            if (event.level !== "error" || disconnectAlertedAt !== null) return;
            disconnectAlertedAt = now();
            emit({ kind: "alert.disconnected", sinceMs: OFFLINE_ALERT_THRESHOLD_MS });
            return;
          }
          case "reconnect.attempt_success":
          case "bridge.connected": {
            // Answer the alert.disconnected the phone is still showing. A
            // one-minute outage gets the same note — the user who just read
            // "you are offline" is watching for exactly this. Never sent for
            // an outage that was never alerted (a blip under the threshold).
            if (disconnectAlertedAt !== null) {
              emit({ kind: "alert.recovered", offlineMs: Math.max(0, now() - disconnectAlertedAt) });
              disconnectAlertedAt = null;
            }
            return;
          }
          case "bridge.device_mismatch":
            emit({ kind: "alert.fatal", code: "device_mismatch", message: truncate(event.message) });
            return;
          case "bridge.client_mismatch":
            emit({ kind: "alert.fatal", code: "client_mismatch", message: truncate(event.message) });
            return;
          case "bridge.credential_rejected":
            emit({ kind: "alert.fatal", code: "credential_rejected", message: truncate(event.message) });
            return;
          // The reconnect loop stopping for good ends the process (bridge-run
          // exits non-zero so the supervisor restarts it). If that restart does
          // not take, the agent is simply gone — which is exactly the thing the
          // phone is here to notice.
          case "reconnect.give_up":
          case "reconnect.closed":
            emit({ kind: "alert.fatal", code: "bridge_stopped", message: truncate(event.message) });
            return;
          default:
            return;
        }
      } catch {
        // Same contract as above: logging must not be able to break logging.
      }
    },

    observeTrace: (trace) => {
      try {
        if (trace.type === "runtime_failure") {
          // Not an alert on its own: a retry may still rescue the turn. Kept so
          // the alert below can name the cause instead of shrugging.
          remember(
            lastRuntimeFailure,
            trace.matchId,
            trace.errorClass !== undefined ? `${trace.errorClass}: ${trace.error}` : trace.error,
          );
          return;
        }
        if (trace.type !== "final_action" || trace.source !== "fallback") return;
        // The turn was played by the bridge's own deterministic move, not by the
        // model — whatever the cause. That is the thing worth waking a phone for.
        const cause = lastRuntimeFailure.get(trace.matchId);
        lastRuntimeFailure.delete(trace.matchId);
        emitLlmFailure(trace.matchId, "fallback_action", cause ?? trace.reason ?? "the model did not produce a usable action");
      } catch {
        // Same contract as the rest: the notifier never reaches the bridge.
      }
    },

    stop: () => opts.channel.stop(),
  };
}

/** The reconnect layer's own "this is now serious" threshold, mirrored here for
 *  the alert text. Kept in sync with SEVERITY_ERROR_THRESHOLD_MS in
 *  wsclient/reconnect.ts — a drift only changes wording, never behaviour. */
export const OFFLINE_ALERT_THRESHOLD_MS = 15 * 60_000;

function truncate(raw: string): string {
  const text = raw.trim();
  return text.length <= REASON_MAX_CHARS ? text : `${text.slice(0, REASON_MAX_CHARS - 1)}…`;
}

function isGameOverData(value: unknown): value is MsgGameOver["data"] {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.match_id === "string" &&
    typeof v.session_id === "string" &&
    Array.isArray(v.players) &&
    typeof v.result === "object" &&
    v.result !== null
  );
}
