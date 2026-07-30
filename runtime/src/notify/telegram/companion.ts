// The Telegram end of the notification pipeline: a NotifyChannel that turns
// events into messages, plus the composition root the bridge calls.
//
// Two promises hold this together:
//   1. deliver() returns immediately. It is called from the bridge's own
//      message loop, so it may not await a network round trip.
//   2. Nothing in here throws outward. A dead network, a revoked token, a
//      blocked bot — all of it degrades to "the phone stayed quiet".

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig, type BridgeTelegramConfig } from "../../bridge/config";
import { resolveNotifyLocale } from "../locale";
import {
  createBridgeNotifier,
  type BridgeLogEvent,
  type BridgeNotifier,
  type NotifyChannel,
  type NotifyEvent,
} from "../events";
import { TELEGRAM_DEFAULT_DIGEST_AT, isMuted } from "./settings";
import { buildDailyDigest, startDigestScheduler, type DigestDeps } from "./digest";
import { createChallengeWatcher } from "./challenge-watch";
import { createTelegramApi, type TelegramApi, type TelegramUpdate } from "./api";
import { createPanelHandler, type PanelRunner } from "./panels";
import { startTelegramPoller, type TelegramPollerHandle } from "./poller";
import { renderNotifyEvent } from "./render";

/** Longest we hold up bridge shutdown waiting for queued messages. */
const FLUSH_BUDGET_MS = 1_500;

/** Sends still queued beyond this are dropped: a phone that is 200 messages
 *  behind does not need them, and an unbounded chain would keep the process
 *  alive at shutdown. Alerts are the exception — see makeRoomFor. */
const MAX_PENDING = 50;

export interface TelegramChannelOptions {
  readonly api: TelegramApi;
  /** Read fresh on every event — the in-chat settings panel edits them live. */
  readonly settings: () => BridgeTelegramConfig;
  /** Also read fresh: a rename made from the chat has to show up in the very
   *  next report, not after a restart. */
  readonly agentName: () => string;
  readonly onLog?: (event: BridgeLogEvent) => void;
  readonly now?: () => number;
}

export function createTelegramChannel(opts: TelegramChannelOptions): NotifyChannel {
  const now = opts.now ?? Date.now;
  let stopped = false;
  /** One entry per queued-or-sending message, oldest first. The list IS the
   *  backlog the MAX_PENDING cap applies to, and the only place a queued
   *  message can be sacrificed to make room for an alert. */
  interface PendingSend {
    readonly event: NotifyEvent;
    /** Set when its turn on the chain has come — too late to drop. */
    started: boolean;
    /** Sacrificed for an alert before its turn came; its chain link no-ops. */
    dropped: boolean;
  }
  const pendingSends: PendingSend[] = [];
  /** Sends run one after another so the chat reads in the order things happened. */
  let tail: Promise<void> = Promise.resolve();

  function accepts(event: NotifyEvent): boolean {
    const settings = opts.settings();
    if (event.kind.startsWith("alert.")) {
      // Muting means "stop chatting", never "stop telling me it is broken".
      return settings.alerts;
    }
    if (isMuted(settings, now())) return false;
    switch (event.kind) {
      case "match.result":
        return settings.results === "per_match" || settings.results === "both";
      case "digest.daily":
        return settings.results === "daily" || settings.results === "both";
      case "challenge.accepted":
        return settings.challengeEvents;
      default:
        return true;
    }
  }

  /**
   * Queue-full policy. Normally the newcomer is dropped. But an alert is the
   * reason the phone exists — a "the bridge is down" must not die behind 50
   * match reports — so it takes the slot of the oldest not-yet-sent non-alert
   * instead. A queue that is nothing but alerts keeps the old policy.
   */
  function makeRoomFor(event: NotifyEvent): boolean {
    if (event.kind.startsWith("alert.")) {
      const at = pendingSends.findIndex((p) => !p.started && !p.event.kind.startsWith("alert."));
      if (at !== -1) {
        const [victim] = pendingSends.splice(at, 1);
        victim!.dropped = true;
        opts.onLog?.({
          level: "warning",
          code: "telegram.queue_full",
          message: `Telegram is not keeping up; dropped a ${victim!.event.kind} notification to make room for an alert`,
        });
        return true;
      }
    }
    opts.onLog?.({
      level: "warning",
      code: "telegram.queue_full",
      message: `Telegram is not keeping up; dropped a ${event.kind} notification`,
    });
    return false;
  }

  async function send(event: NotifyEvent): Promise<void> {
    const settings = opts.settings();
    const locale = resolveNotifyLocale(settings.locale);
    const message = renderNotifyEvent(locale, event, { agentName: opts.agentName() });

    if (message.photoUrl !== undefined) {
      try {
        await opts.api.sendPhoto({
          chatId: settings.chatId,
          photoUrl: message.photoUrl,
          caption: message.text,
          ...(message.keyboard !== undefined ? { keyboard: message.keyboard } : {}),
        });
        return;
      } catch (cause) {
        // The card is the garnish, not the meal: if Telegram cannot fetch the
        // image (card switch off, private replay, slow render) the report still
        // has to arrive, as text.
        opts.onLog?.({
          level: "info",
          code: "telegram.photo_fallback",
          message: `Sent the match report without its card: ${describe(cause)}`,
        });
      }
    }

    await opts.api.sendMessage({
      chatId: settings.chatId,
      text: message.text,
      disablePreview: true,
      ...(message.keyboard !== undefined ? { keyboard: message.keyboard } : {}),
    });
  }

  return {
    deliver: (event) => {
      if (stopped) return;
      let wanted: boolean;
      try {
        wanted = accepts(event);
      } catch {
        return; // an unreadable settings block must not break the bridge
      }
      if (!wanted) return;
      if (pendingSends.length >= MAX_PENDING && !makeRoomFor(event)) return;
      const entry: PendingSend = { event, started: false, dropped: false };
      pendingSends.push(entry);
      tail = tail.then(async () => {
        entry.started = true;
        try {
          if (!entry.dropped) await send(event);
        } catch (cause) {
          opts.onLog?.({
            level: "warning",
            code: "telegram.send_failed",
            message: `Could not send a ${event.kind} notification: ${describe(cause)}`,
          });
        } finally {
          const at = pendingSends.indexOf(entry);
          if (at !== -1) pendingSends.splice(at, 1);
        }
      });
    },

    stop: async () => {
      stopped = true;
      // Bounded: shutdown waits for the queue, but never on the network.
      await Promise.race([tail, sleep(FLUSH_BUDGET_MS)]);
    },
  };
}

export interface TelegramCompanionDeps {
  readonly config: BridgeConfig;
  /** Live bridge, for the panel's controls. Omit for notifications only. */
  readonly runner?: PanelRunner | null;
  readonly onLog?: (event: BridgeLogEvent) => void;
  readonly fetchImpl?: typeof fetch;
  /** Test seam: supply a stubbed Bot API instead of the real one. */
  readonly apiFactory?: (token: string) => TelegramApi;
  readonly now?: () => number;
  /** Test seam: persist config changes somewhere other than bridge.json. */
  readonly persistConfig?: (next: BridgeConfig) => void;
  /** Test seam: skip the getUpdates loop (panel tests drive it directly). */
  readonly poll?: boolean;
  /** Test seam: digest data sources (sessions, usage ledger, snapshot file). */
  readonly digest?: Partial<DigestDeps>;
}

/** The only bridge-config fields the in-chat panel may write. */
type ConfigPatch = Partial<Pick<BridgeConfig, "autoDailyLimit" | "telegram" | "agentName">>;

export interface TelegramCompanion extends BridgeNotifier {
  /** Feed one Telegram update by hand (the poller does this on its own). */
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

/**
 * Send one alert without starting a companion, for the window where there is no
 * companion to start one from: the bridge refuses to connect (another client
 * owns the agent, or the key was rejected) and never reaches the point where
 * the companion is mounted. That refusal — the agent is off the board, possibly
 * all night — is exactly what the phone is for.
 *
 * Best-effort and bounded: it never throws and never blocks startup for long.
 */
export async function notifyBridgeUnavailable(
  config: BridgeConfig,
  code: Extract<NotifyEvent, { kind: "alert.fatal" }>["code"],
  message: string,
  opts: { readonly fetchImpl?: typeof fetch; readonly apiFactory?: (token: string) => TelegramApi } = {},
): Promise<void> {
  const section = config.telegram;
  const token = config.telegramBotToken;
  if (section === undefined || token === undefined || !section.alerts) return;
  try {
    const api = opts.apiFactory !== undefined
      ? opts.apiFactory(token)
      : createTelegramApi({ token, ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}) });
    const rendered = renderNotifyEvent(resolveNotifyLocale(section.locale), { kind: "alert.fatal", code, message }, {
      agentName: config.agentName,
    });
    await api.sendMessage({ chatId: section.chatId, text: rendered.text, disablePreview: true });
  } catch {
    // A phone that cannot be reached must not stand between the bridge and its
    // own startup path.
  }
}

/**
 * Start the companion for this bridge process, or return null when it is not
 * configured — which is the default and costs nothing.
 *
 * The bridge feeds it server messages and log events; it decides what deserves
 * a message and sends it. Two-way control arrives with the panel batch.
 */
export function startTelegramCompanion(deps: TelegramCompanionDeps): TelegramCompanion | null {
  const section = deps.config.telegram;
  const token = deps.config.telegramBotToken;
  if (section === undefined || token === undefined) return null;

  const api = deps.apiFactory !== undefined
    ? deps.apiFactory(token)
    : createTelegramApi({ token, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) });

  // A snapshot per process: bridge.json is not watched, so the CLI's own edits
  // land on the next restart (`aifight telegram status` says as much). The
  // in-chat panel edits THIS object, so its changes apply at once.
  let config: BridgeConfig = deps.config;
  let settings: BridgeTelegramConfig = section;
  /** Newest replay this process has seen, for the Links panel. */
  let lastReplayUrl: string | undefined;

  const channel = createTelegramChannel({
    api,
    settings: () => settings,
    agentName: () => config.agentName,
    ...(deps.onLog !== undefined ? { onLog: deps.onLog } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  const notifier = createBridgeNotifier({
    agentId: config.agentId,
    baseUrl: config.baseUrl,
    channel: {
      deliver: (event) => {
        if (event.kind === "match.result" && event.replayUrl !== undefined) lastReplayUrl = event.replayUrl;
        channel.deliver(event);
      },
      stop: () => channel.stop(),
    },
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  /**
   * Write a config change back to disk without clobbering whatever else
   * changed there. bridge.json is shared with the desktop app and the CLI, so
   * the merge is onto a FRESH read and carries only the fields this panel
   * actually changed — writing back a whole in-memory snapshot would silently
   * revert someone else's edit (e.g. a rename made from the Dashboard between
   * our read and our write).
   *
   * Returns true when the change is on disk. A failed write is logged, not
   * thrown: the change still holds for this session, and a settings toggle is
   * never worth taking the bridge down for — but the panel is told (via the
   * return value) so it can say "session-only" instead of implying "saved".
   *
   * preserveMtime: the change is already live in this process, so the write is
   * behaviour-neutral for the running bridge and must not trip the
   * restart-pending mtime check (see writeBridgeConfig).
   */
  function persist(patch: ConfigPatch): boolean {
    const previousSection = settings;
    config = { ...config, ...patch };
    if (patch.telegram !== undefined) settings = patch.telegram;
    if (deps.persistConfig !== undefined) {
      deps.persistConfig(config);
      return true;
    }
    try {
      const onDisk = readBridgeConfig();
      const merged: { -readonly [K in keyof ConfigPatch]: ConfigPatch[K] } = { ...patch };
      let telegramDropped = false;
      if (patch.telegram !== undefined) {
        // The section is an OBJECT, so "only the fields that changed" has to go
        // one level deeper: writing this process's whole snapshot back would
        // revert a `telegram set` made from the CLI since the bridge started —
        // and, worse, put back a section that `telegram unlink` just removed.
        if (onDisk.telegram === undefined) {
          // Unlinked under our feet. Only the telegram half of the patch is
          // dropped — the rest (a daily cap, a rename) still lands on disk.
          delete merged.telegram;
          telegramDropped = true;
        } else {
          merged.telegram = mergeSection(onDisk.telegram, previousSection, patch.telegram);
        }
      }
      // A rename is NOT behaviour-neutral for the running bridge: the control
      // API keeps routing by the boot-time name, so `aifight start/stop`
      // addressed to the new name 404 until a restart. That one write must
      // bump the mtime so the CLI's restart-pending hint fires; every other
      // panel write (toggles, mutes, daily cap) stays neutral.
      writeBridgeConfig(
        { ...onDisk, ...merged, updatedAt: new Date().toISOString() },
        { preserveMtime: merged.agentName === undefined },
      );
      if (telegramDropped) {
        deps.onLog?.({
          level: "warning",
          code: "telegram.config_write_skipped",
          message: "This machine was unlinked from Telegram, so the change was not saved; it applies until the bridge restarts.",
        });
        return false;
      }
      return true;
    } catch (cause) {
      deps.onLog?.({
        level: "warning",
        code: "telegram.config_write_failed",
        message: `Applied for this session, but could not save it: ${describe(cause)}`,
      });
      return false;
    }
  }

  // Challenges created from the chat are watched so their acceptance can be
  // announced; see challenge-watch.ts for why this is a poll and not a push.
  const challenges = createChallengeWatcher({
    baseUrl: config.baseUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    onAccepted: ({ game, guestName }) => {
      channel.deliver({
        kind: "challenge.accepted",
        game,
        ...(guestName !== undefined ? { guestName } : {}),
      });
    },
    onLog: (message) => {
      deps.onLog?.({ level: "info", code: "telegram.challenge_watch", message });
    },
  });

  const panel = createPanelHandler({
    api,
    settings: () => settings,
    updateSettings: (next) => persist({ telegram: next }),
    config: () => config,
    updateConfig: (next) => persist({
      ...(next.autoDailyLimit !== config.autoDailyLimit ? { autoDailyLimit: next.autoDailyLimit } : {}),
      ...(next.agentName !== config.agentName ? { agentName: next.agentName } : {}),
      ...(next.telegram !== config.telegram ? { telegram: next.telegram } : {}),
    }),
    runner: deps.runner ?? null,
    lastReplayUrl: () => lastReplayUrl,
    watchChallenge: (token, game) => challenges.watch(token, game),
    // updateConfig already saved the new name; this only refreshes what the
    // channel signs its messages with.
    onRenamed: (name) => {
      config = { ...config, agentName: name };
    },
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.onLog !== undefined ? { onLog: deps.onLog } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  // One digest a day, if the user asked for one. The scheduler ticks rather
  // than sleeping to a deadline, so a laptop that was shut when the slot came
  // round still gets it on wake.
  const digest = startDigestScheduler({
    digestAt: () => settings.digestAt ?? TELEGRAM_DEFAULT_DIGEST_AT,
    onDigest: async () => {
      if (settings.results !== "daily" && settings.results !== "both") return;
      const event = await buildDailyDigest({
        agentId: config.agentId,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.digest ?? {}),
      });
      channel.deliver(event);
    },
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  // Remote control off = nothing to listen for, so nothing is polled: no
  // network chatter, no surface. Turning it back on is a CLI action.
  let poller: TelegramPollerHandle | null = null;
  if (settings.control && deps.poll !== false) {
    poller = startTelegramPoller({
      api,
      onUpdate: (update) => panel.handleUpdate(update),
      ...(deps.onLog !== undefined
        ? { onLog: (e) => deps.onLog!({ level: e.level, code: e.code, message: e.message }) }
        : {}),
    });
  }

  deps.onLog?.({
    level: "info",
    code: "telegram.started",
    message: settings.control
      ? `Telegram companion active for chat ${settings.chatId} (notifications + remote control)`
      : `Telegram companion active for chat ${settings.chatId} (notifications only)`,
  });

  return {
    observeServerMessage: (message) => notifier.observeServerMessage(message),
    observeLog: (event) => notifier.observeLog(event),
    observeTrace: (trace) => notifier.observeTrace(trace),
    handleUpdate: (update) => panel.handleUpdate(update),
    stop: async () => {
      digest.stop();
      challenges.stop();
      await poller?.stop();
      await notifier.stop();
    },
  };
}

/**
 * Apply just this edit's fields onto the section that is on disk now.
 *
 * `before` is what this process thought the section was; anything that differs
 * in `after` is what the user just changed here, and only that is carried over.
 * A key that vanished (mutedUntil, on unmute) is a deletion, not a no-op.
 */
function mergeSection(
  onDisk: BridgeTelegramConfig,
  before: BridgeTelegramConfig,
  after: BridgeTelegramConfig,
): BridgeTelegramConfig {
  const merged = { ...onDisk } as Record<string, unknown>;
  const beforeFields = before as unknown as Record<string, unknown>;
  const afterFields = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])) {
    const next = afterFields[key];
    if (next === beforeFields[key]) continue; // untouched by this edit
    if (next === undefined) delete merged[key];
    else merged[key] = next;
  }
  return merged as unknown as BridgeTelegramConfig;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // unref so a pending flush timer can never hold the process open.
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
