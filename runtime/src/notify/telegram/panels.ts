// The chat-window control panel: one message that swaps its own contents as
// you tap through it, the way a settings screen does.
//
// Three rules shape everything here:
//   1. The bot answers exactly one chat — the one that completed pairing.
//      Anything else is met with silence, not an error (a probe learns nothing).
//   2. Anything with a consequence — starting a match, pausing, changing the
//      daily cap, renaming — needs a second tap carrying a one-shot nonce, so a
//      stale button someone scrolls back to cannot fire an action.
//   3. The panel exposes only what the CLI already exposes. It never touches
//      LLM configuration, API keys, or strategy files.

import {
  AgentActionError,
  acceptChallenge,
  createChallenge,
  renameAgent,
  type ChallengeGame,
} from "../../bridge/agent-actions";
import { findChallengeTokenInText } from "../../bridge/challenge-link";
import type { BridgeConfig, BridgeTelegramConfig } from "../../bridge/config";
import { pickAutomaticGame, type SupportedGame } from "../../bridge/auto-join";
import {
  DAILY_CAP_CONFIRM_THRESHOLD,
  DailyPolicySyncError,
  SETUP_WIZARD_CAP_MAX,
  dailyCapNeedsConfirm,
  syncDailyPolicy,
} from "../../bridge/daily-policy";
import { fetchNoFollow } from "../../net/guarded-fetch";
import { sameOriginUrl } from "../safe-url";
import type { BridgeLogEvent } from "../events";
import { resolveNotifyLocale, type NotifyLocale } from "../locale";
import { escapeHtml, type TelegramApi, type TelegramInlineKeyboard, type TelegramUpdate } from "./api";
import { connectionStateText, gameName, resultsPreferenceText, t } from "./render";
import { applyTelegramSetting, isMuted, parseMuteSpec } from "./settings";

export const CALLBACK_VERSION = "v1";

/** Telegram's hard limit on callback_data. Encoding refuses anything longer
 *  rather than shipping a button that silently fails on the phone. */
export const CALLBACK_MAX_BYTES = 64;

/** A confirmation button is good for ten minutes, once. */
const NONCE_TTL_MS = 10 * 60_000;
const NONCE_LENGTH = 8;
const NONCE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** How long a "send me the number" prompt stays armed. */
const PENDING_INPUT_TTL_MS = 5 * 60_000;

/** The server's own display-name bounds (internal/agentname: MinRunes/MaxRunes),
 *  mirrored so the prompt promises exactly what the API accepts. The charset
 *  rule stays the server's — its refusal names the offending character, which is
 *  more useful than anything a second copy of the rule could say. */
const NAME_MIN_CHARS = 2;
const NAME_MAX_CHARS = 50;

const STATUS_TIMEOUT_MS = 4_000;

export const PLAYABLE_GAMES: readonly SupportedGame[] = ["texas_holdem", "liars_dice", "coup"];

// ── callback_data codec ──────────────────────────────────────────────

export interface CallbackData {
  readonly panel: string;
  readonly action: string;
  readonly arg?: string;
  readonly nonce?: string;
}

export function encodeCallback(data: CallbackData): string {
  const parts = [CALLBACK_VERSION, data.panel, data.action, data.arg ?? "", data.nonce ?? ""];
  // Trailing empties are dropped so the common "just navigate" button stays short.
  while (parts.length > 3 && parts[parts.length - 1] === "") parts.pop();
  const encoded = parts.join(":");
  if (Buffer.byteLength(encoded, "utf8") > CALLBACK_MAX_BYTES) {
    throw new Error(`callback data too long for Telegram: ${encoded}`);
  }
  return encoded;
}

export function decodeCallback(raw: string): CallbackData | null {
  const parts = raw.split(":");
  if (parts.length < 3 || parts.length > 5) return null;
  if (parts[0] !== CALLBACK_VERSION) return null;
  const [, panel, action, arg, nonce] = parts;
  if (panel === undefined || panel === "" || action === undefined || action === "") return null;
  return {
    panel,
    action,
    ...(arg !== undefined && arg !== "" ? { arg } : {}),
    ...(nonce !== undefined && nonce !== "" ? { nonce } : {}),
  };
}

// ── one-shot confirmation nonces ─────────────────────────────────────

export interface NonceStore {
  /** Mint a nonce bound to one intent (e.g. "play:start:coup"). */
  issue(intent: string): string;
  /** True exactly once, for the matching intent, inside the TTL. */
  consume(nonce: string, intent: string): boolean;
}

export function createNonceStore(opts: { now?: () => number; ttlMs?: number; random?: () => number } = {}): NonceStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? NONCE_TTL_MS;
  const random = opts.random ?? Math.random;
  const issued = new Map<string, { intent: string; expiresAt: number }>();

  return {
    issue: (intent) => {
      // Opportunistic sweep — the store never holds more than a few entries.
      for (const [key, value] of issued) if (value.expiresAt <= now()) issued.delete(key);
      let nonce = "";
      for (let i = 0; i < NONCE_LENGTH; i += 1) {
        nonce += NONCE_ALPHABET[Math.floor(random() * NONCE_ALPHABET.length)];
      }
      issued.set(nonce, { intent, expiresAt: now() + ttlMs });
      return nonce;
    },
    consume: (nonce, intent) => {
      const entry = issued.get(nonce);
      if (entry === undefined) return false;
      issued.delete(nonce); // one-shot, even on a mismatch
      if (entry.expiresAt <= now()) return false;
      return entry.intent === intent;
    },
  };
}

// ── panel dependencies ───────────────────────────────────────────────

/** The slice of BridgeRunner the panel is allowed to touch. */
export interface PanelRunner {
  snapshot(): { readonly state: { readonly phase?: string } | null } | null;
  connectionSnapshot(): { readonly state: string; readonly connectedAt: number | null } | null;
  joinQueue(game: SupportedGame, mode?: string, opts?: { readonly oneShot?: boolean; readonly count?: number }): void;
  leaveQueue(): void;
}

export interface PanelDeps {
  readonly api: TelegramApi;
  readonly settings: () => BridgeTelegramConfig;
  /** Persist + apply a settings change (in-memory for this process, on disk for the next).
   *  False = live for this session but NOT saved; the panel then says so,
   *  because showing the new value alone would read as "saved". */
  readonly updateSettings: (next: BridgeTelegramConfig) => boolean;
  readonly config: () => BridgeConfig;
  /** Persist a bridge-config change (currently only autoDailyLimit). Same
   *  return contract as updateSettings. */
  readonly updateConfig: (next: BridgeConfig) => boolean;
  readonly runner: PanelRunner | null;
  readonly fetchImpl?: typeof fetch;
  readonly onLog?: (event: BridgeLogEvent) => void;
  readonly now?: () => number;
  readonly nonces?: NonceStore;
  /** Newest replay this process has seen, for the Links panel. */
  readonly lastReplayUrl?: () => string | undefined;
  /** Start watching a challenge created here, so its acceptance is announced. */
  readonly watchChallenge?: (token: string, game: string) => void;
  /** Called after a successful rename so the process uses the new name. */
  readonly onRenamed?: (name: string) => void;
}

export interface PanelHandler {
  /** Handle one Telegram update. Never throws. */
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

interface PendingInput {
  readonly kind: "daily" | "rename";
  readonly expiresAt: number;
}

/** A name waiting for its confirmation tap. It is held here rather than in the
 *  button, because a legal 50-character name does not fit in Telegram's 64-byte
 *  callback payload — and a button that cannot be encoded is a button that does
 *  nothing at all. The nonce ties the two together. */
interface PendingRename {
  readonly nonce: string;
  readonly name: string;
}

export function createPanelHandler(deps: PanelDeps): PanelHandler {
  const now = deps.now ?? Date.now;
  const nonces = deps.nonces ?? createNonceStore({ now });
  let pendingInput: PendingInput | null = null;
  let pendingRename: PendingRename | null = null;
  /** Whether the panel believes automatic matching is paused. Best-effort: it
   *  reflects taps made here, not a server-side truth we cannot read. */
  let paused = false;

  const locale = (): NotifyLocale => resolveNotifyLocale(deps.settings().locale);

  async function handle(update: TelegramUpdate): Promise<void> {
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    // Rule 1: exactly one chat, and no reply to anyone else.
    if (chatId === undefined || chatId !== deps.settings().chatId) return;

    // settings.control === false never reaches here: the companion does not
    // even start the poller then (notifications-only mode), so there is no
    // "reply that control is off" branch — the bot is simply silent.

    if (update.callback_query !== undefined) {
      await handleCallback(chatId, update.callback_query);
      return;
    }
    if (update.message?.text !== undefined) {
      await handleText(chatId, update.message.text, update.message.message_id);
    }
  }

  // ── text commands ──────────────────────────────────────────────────

  async function handleText(chatId: number, rawText: string, _messageId: number): Promise<void> {
    const text = rawText.trim();

    // A pending force-reply answer wins over command parsing, so a bare number
    // is read as the cap the user was just asked for.
    if (pendingInput !== null && !text.startsWith("/")) {
      if (pendingInput.expiresAt <= now()) {
        pendingInput = null;
      } else {
        const kind = pendingInput.kind;
        pendingInput = null;
        if (kind === "daily") {
          await handleCustomDaily(chatId, text);
          return;
        }
        if (kind === "rename") {
          await handleRenameInput(chatId, text);
          return;
        }
      }
    }

    // A command means the user walked away from the prompt. Leaving it armed
    // would make the NEXT ordinary message — a pasted challenge link, say — get
    // read as the answer to a question asked five minutes ago.
    if (text.startsWith("/")) pendingInput = null;

    const command = /^\/([a-z_]+)/i.exec(text)?.[1]?.toLowerCase();
    switch (command) {
      case "start":
      case "menu":
        await sendPanel(chatId, homePanel());
        return;
      case "status":
        await sendPanel(chatId, await statusPanel());
        return;
      case "daily":
        await sendPanel(chatId, settingsPanel());
        return;
      case "links":
        await sendPanel(chatId, linksPanel());
        return;
      case "mute":
        await sendPanel(chatId, notifyPanel());
        return;
      case "help":
        await send(chatId, t(locale(), "help_body"));
        return;
      case "challenge":
        await sendPanel(chatId, duelPanel());
        return;
      default: {
        // The smoothest way to accept a challenge is to forward the link
        // straight to the bot, so any message carrying one offers to take it.
        const token = findChallengeTokenInText(text);
        if (token !== null) {
          // The whole token rides in the callback data (59 of the 64 bytes
          // Telegram allows), so accepting needs no side state to go stale.
          await sendPanel(chatId, confirmPanel(
            t(locale(), "confirm_accept_challenge"),
            { panel: "duel", action: "accept", arg: token, nonce: nonces.issue(`duel:accept:${token}`) },
            "duel",
          ));
          return;
        }
        await sendPanel(chatId, homePanel());
      }
    }
  }

  // ── callbacks ──────────────────────────────────────────────────────

  async function handleCallback(
    chatId: number,
    query: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<void> {
    const answer = async (text?: string): Promise<void> => {
      try {
        await deps.api.answerCallbackQuery({ id: query.id, ...(text !== undefined ? { text } : {}) });
      } catch {
        // Only clears the phone's spinner; not worth failing the action over.
      }
    };
    const data = query.data === undefined ? null : decodeCallback(query.data);
    if (data === null) {
      await answer();
      return;
    }
    const messageId = query.message?.message_id;
    const l = locale();

    const show = async (panel: Panel): Promise<void> => {
      await answer();
      if (messageId === undefined) {
        await sendPanel(chatId, panel);
        return;
      }
      await edit(chatId, messageId, panel);
    };

    switch (`${data.panel}:${data.action}`) {
      // ── navigation ──
      case "home:open":
        return show(homePanel());
      case "status:open":
      case "status:refresh":
        return show(await statusPanel());
      case "play:open":
        return show(playPanel());
      case "notify:open":
        return show(notifyPanel());
      case "settings:open":
        return show(settingsPanel());
      case "links:open":
        return show(linksPanel());

      // ── play ──
      case "play:ask_start": {
        const game = asGame(data.arg);
        if (game === null) return answer();
        return show(confirmPanel(
          t(l, "confirm_start_match", { game: gameName(l, game) }),
          { panel: "play", action: "start", arg: game, nonce: nonces.issue(`play:start:${game}`) },
          "play",
        ));
      }
      case "play:start": {
        const game = asGame(data.arg);
        if (game === null || data.nonce === undefined || !nonces.consume(data.nonce, `play:start:${game}`)) {
          await answer(t(l, "toast_expired"));
          return show(playPanel());
        }
        const failure = tryRunner(() => {
          deps.runner?.joinQueue(game, "ranked", { oneShot: true });
        });
        await answer();
        return show(playPanel(failure ?? t(l, "play_started", { game: gameName(l, game) })));
      }
      case "play:ask_pause":
        return show(confirmPanel(
          t(l, "confirm_pause"),
          { panel: "play", action: "pause", nonce: nonces.issue("play:pause") },
          "play",
        ));
      case "play:pause": {
        if (data.nonce === undefined || !nonces.consume(data.nonce, "play:pause")) {
          await answer(t(l, "toast_expired"));
          return show(playPanel());
        }
        const failure = tryRunner(() => {
          deps.runner?.leaveQueue();
        });
        paused = failure === null;
        await answer();
        return show(playPanel(failure ?? t(l, "play_paused")));
      }
      case "play:ask_resume":
        return show(confirmPanel(
          t(l, "confirm_resume"),
          { panel: "play", action: "resume", nonce: nonces.issue("play:resume") },
          "play",
        ));
      case "play:resume": {
        if (data.nonce === undefined || !nonces.consume(data.nonce, "play:resume")) {
          await answer(t(l, "toast_expired"));
          return show(playPanel());
        }
        const game = pickAutomaticGame(deps.config().autoGames);
        const failure = tryRunner(() => {
          deps.runner?.joinQueue(game, "ranked");
        });
        if (failure === null) paused = false;
        await answer();
        return show(playPanel(failure ?? t(l, "play_resumed")));
      }

      // ── notifications ──
      case "notify:results": {
        const outcome = applyTelegramSetting(deps.settings(), "results", data.arg ?? "");
        if (outcome.ok && !deps.updateSettings(outcome.section)) return show(notifyPanel(t(l, "settings_unsaved")));
        return show(notifyPanel());
      }
      case "notify:mute": {
        const parsed = parseMuteSpec(data.arg ?? "", now());
        if (parsed.ok) {
          const section = deps.settings();
          const saved = deps.updateSettings(
            parsed.mutedUntil === undefined
              ? dropMute(section)
              : { ...section, mutedUntil: parsed.mutedUntil },
          );
          if (!saved) return show(notifyPanel(t(l, "settings_unsaved")));
        }
        return show(notifyPanel());
      }
      case "notify:alerts":
      case "notify:challenges": {
        const key = data.action === "alerts" ? "alerts" : "challenge_events";
        const outcome = applyTelegramSetting(deps.settings(), key, data.arg ?? "");
        if (outcome.ok && !deps.updateSettings(outcome.section)) return show(notifyPanel(t(l, "settings_unsaved")));
        return show(notifyPanel());
      }

      // ── settings ──
      case "settings:ask_daily": {
        const limit = Number.parseInt(data.arg ?? "", 10);
        if (!Number.isInteger(limit) || limit < 0 || limit > SETUP_WIZARD_CAP_MAX) return answer();
        return show(dailyConfirmPanel(limit));
      }
      case "settings:daily": {
        const limit = Number.parseInt(data.arg ?? "", 10);
        if (
          !Number.isInteger(limit) ||
          data.nonce === undefined ||
          !nonces.consume(data.nonce, `settings:daily:${limit}`)
        ) {
          await answer(t(l, "toast_expired"));
          return show(settingsPanel());
        }
        await answer();
        return show(settingsPanel(await applyDailyLimit(limit)));
      }
      case "settings:custom_daily": {
        await answer();
        pendingInput = { kind: "daily", expiresAt: now() + PENDING_INPUT_TTL_MS };
        await send(chatId, t(l, "settings_custom_prompt", { max: SETUP_WIZARD_CAP_MAX }), { forceReply: true });
        return;
      }
      // ── duel ──
      case "duel:open":
        return show(duelPanel());
      case "duel:ask_create": {
        const game = asGame(data.arg);
        if (game === null) return answer();
        return show(confirmPanel(
          t(l, "confirm_create_challenge", { game: gameName(l, game) }),
          { panel: "duel", action: "create", arg: game, nonce: nonces.issue(`duel:create:${game}`) },
          "duel",
        ));
      }
      case "duel:create": {
        const game = asGame(data.arg);
        if (game === null || data.nonce === undefined || !nonces.consume(data.nonce, `duel:create:${game}`)) {
          await answer(t(l, "toast_expired"));
          return show(duelPanel());
        }
        await answer();
        try {
          const created = await createChallenge(deps.config(), game as ChallengeGame, deps.fetchImpl ?? globalThis.fetch);
          // The link is about to be forwarded to a friend from the user's own
          // chat, so it has to be an AIFight link — see notify/safe-url.ts.
          const joinUrl = sameOriginUrl(deps.config().baseUrl, created.joinUrl);
          if (joinUrl === undefined) {
            return show(duelPanel(t(l, "action_failed", { reason: escapeHtml("the challenge link did not point at AIFight") })));
          }
          if (created.token !== null) deps.watchChallenge?.(created.token, game);
          // A separate message, not a panel edit: this one is meant to be
          // forwarded to whoever you are challenging.
          await send(chatId, t(l, "challenge_share", {
            game: gameName(l, game),
            url: escapeHtml(joinUrl),
          }));
          return show(duelPanel());
        } catch (cause) {
          return show(duelPanel(actionFailure(l, cause)));
        }
      }
      case "duel:accept": {
        const token = data.arg;
        if (token === undefined || data.nonce === undefined || !nonces.consume(data.nonce, `duel:accept:${token}`)) {
          await answer(t(l, "toast_expired"));
          return show(duelPanel());
        }
        await answer();
        try {
          await acceptChallenge(deps.config(), token, deps.fetchImpl ?? globalThis.fetch);
          return show(duelPanel(t(l, "challenge_accepted_ok")));
        } catch (cause) {
          return show(duelPanel(actionFailure(l, cause)));
        }
      }

      // ── rename ──
      case "settings:ask_rename": {
        await answer();
        pendingInput = { kind: "rename", expiresAt: now() + PENDING_INPUT_TTL_MS };
        await send(chatId, t(l, "settings_rename_prompt"), { forceReply: true });
        return;
      }
      case "settings:rename": {
        // The name lives in pendingRename, keyed by this nonce; a stale button
        // from an earlier proposal fails the match and leaves the current one
        // alone rather than cancelling it.
        const proposed = pendingRename;
        if (
          data.nonce === undefined ||
          proposed === null ||
          proposed.nonce !== data.nonce ||
          !nonces.consume(data.nonce, "settings:rename")
        ) {
          await answer(t(l, "toast_expired"));
          return show(settingsPanel());
        }
        pendingRename = null;
        await answer();
        try {
          const renamed = await renameAgent(deps.config(), proposed.name, deps.fetchImpl ?? globalThis.fetch);
          const saved = deps.updateConfig({ ...deps.config(), agentName: renamed.name, updatedAt: new Date().toISOString() });
          deps.onRenamed?.(renamed.name);
          const notice = t(l, "settings_renamed", { name: escapeHtml(renamed.name) });
          return show(settingsPanel(saved ? notice : `${notice} ${t(l, "settings_unsaved")}`));
        } catch (cause) {
          return show(settingsPanel(actionFailure(l, cause)));
        }
      }

      case "settings:locale": {
        const outcome = applyTelegramSetting(deps.settings(), "locale", data.arg ?? "");
        if (outcome.ok && !deps.updateSettings(outcome.section)) return show(settingsPanel(t(l, "settings_unsaved")));
        return show(settingsPanel());
      }

      default:
        return answer();
    }
  }

  async function handleCustomDaily(chatId: number, text: string): Promise<void> {
    const l = locale();
    const raw = text.trim();
    if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) > SETUP_WIZARD_CAP_MAX) {
      await send(chatId, t(l, "settings_custom_invalid", { max: SETUP_WIZARD_CAP_MAX }));
      return;
    }
    await sendPanel(chatId, dailyConfirmPanel(Number.parseInt(raw, 10)));
  }

  async function handleRenameInput(chatId: number, text: string): Promise<void> {
    const l = locale();
    const name = text.trim().replace(/\s+/g, " ");
    const length = [...name].length; // characters, the way the server counts them
    if (length < NAME_MIN_CHARS || length > NAME_MAX_CHARS) {
      await send(chatId, t(l, "settings_rename_invalid", { min: NAME_MIN_CHARS, max: NAME_MAX_CHARS }));
      return;
    }
    const nonce = nonces.issue("settings:rename");
    pendingRename = { nonce, name };
    await sendPanel(chatId, confirmPanel(
      t(l, "confirm_rename", { name: escapeHtml(name) }),
      { panel: "settings", action: "rename", nonce },
      "settings",
    ));
  }

  async function applyDailyLimit(asked: number): Promise<string> {
    const l = locale();
    const config = deps.config();
    let outcome;
    try {
      outcome = await syncDailyPolicy(config, asked, deps.fetchImpl ?? globalThis.fetch);
    } catch (cause) {
      return t(l, "settings_daily_failed", {
        reason: escapeHtml(cause instanceof DailyPolicySyncError ? cause.message : describe(cause)),
      });
    }
    // Report what the platform stored, not what was asked for — it clamps to
    // the account ceiling and says so in the response.
    const limit = outcome.effectiveLimit;
    const previous = config.autoDailyLimit ?? 0;
    const saved = deps.updateConfig({ ...config, autoDailyLimit: limit, updatedAt: new Date().toISOString() });

    // Crossing 0 ↔ positive changes whether the bridge queues on its own, and
    // that is decided once, when the process starts. Say so plainly instead of
    // letting the user wonder why nothing happened.
    const crossedZero = (previous === 0) !== (limit === 0);
    const note = crossedZero
      ? ` ${limit === 0 ? t(l, "settings_daily_note_stop") : t(l, "settings_daily_note_start")}`
      : "";
    const headline = limit === asked
      ? t(l, "settings_daily_set", { limit })
      : t(l, "settings_daily_clamped", { limit, asked });
    return headline + note + (saved ? "" : ` ${t(l, "settings_unsaved")}`);
  }

  // ── panels ─────────────────────────────────────────────────────────

  interface Panel {
    readonly text: string;
    readonly keyboard: TelegramInlineKeyboard;
  }

  function homePanel(): Panel {
    const l = locale();
    const config = deps.config();
    return {
      text: [
        `🏟 <b>AIFight · ${escapeHtml(config.agentName)}</b>`,
        connectionLine(l),
      ].join("\n"),
      keyboard: [
        [button(t(l, "btn_status"), { panel: "status", action: "open" }), button(t(l, "btn_play"), { panel: "play", action: "open" })],
        [button(t(l, "btn_duel"), { panel: "duel", action: "open" }), button(t(l, "btn_notify"), { panel: "notify", action: "open" })],
        [button(t(l, "btn_settings"), { panel: "settings", action: "open" }), button(t(l, "btn_links"), { panel: "links", action: "open" })],
      ],
    };
  }

  async function statusPanel(): Promise<Panel> {
    const l = locale();
    const config = deps.config();
    const [status, ratings] = await Promise.all([fetchAgentStatus(), fetchRatings()]);
    const lines = [`📊 <b>${escapeHtml(config.agentName)}</b>`, connectionLine(l)];

    if (status === null) {
      lines.push(t(l, "status_unavailable"));
    } else {
      // A local cap of 0 is stored server-side as auto_requeue:false and leaves
      // max_games_per_day untouched, so the platform still reports the old
      // number. Trusting it here would have this panel and the settings panel
      // quote two different caps.
      const off = (config.autoDailyLimit ?? 0) === 0 || status.maxGamesPerDay === 0;
      lines.push(t(l, "status_today", {
        played: status.gamesToday,
        cap: off ? t(l, "status_cap_off") : String(status.maxGamesPerDay),
      }));
    }
    lines.push(t(l, "status_phase", { phase: escapeHtml(phaseLabel(l)) }));
    if (ratings.length > 0) {
      lines.push(ratings.map((r) => `${gameName(l, r.game)} ${Math.round(r.rating)}`).join(" · "));
    }

    return {
      text: lines.join("\n"),
      keyboard: [[button(t(l, "btn_refresh"), { panel: "status", action: "refresh" }), homeButton(l)]],
    };
  }

  function playPanel(notice?: string): Panel {
    const l = locale();
    // Whether anything automatic is happening at all is a property of the saved
    // cap, not of this panel: at 0 the bridge never queues by itself (see
    // automaticJoinOptions), so there is nothing to pause and "running" would be
    // a plain lie. Manual matches still work — that is the whole panel below.
    const automatic = (deps.config().autoDailyLimit ?? 0) > 0;
    const rows: TelegramInlineKeyboard = [
      ...(automatic
        ? [paused
            ? [button(t(l, "btn_resume"), { panel: "play", action: "ask_resume" })]
            : [button(t(l, "btn_pause"), { panel: "play", action: "ask_pause" })]]
        : []),
      PLAYABLE_GAMES.map((game) => button(gameName(l, game), { panel: "play", action: "ask_start", arg: game })),
      [homeButton(l)],
    ];
    const lines = [
      `🎮 <b>${t(l, "play_title")}</b>`,
      !automatic
        ? t(l, "play_state_manual")
        : paused
          ? t(l, "play_state_paused")
          : t(l, "play_state_running"),
      t(l, "play_manual_hint"),
    ];
    if (notice !== undefined) lines.push("", notice);
    return { text: lines.join("\n"), keyboard: rows };
  }

  function notifyPanel(notice?: string): Panel {
    const l = locale();
    const s = deps.settings();
    const muted = isMuted(s, now());
    const lines = [
      `🔔 <b>${t(l, "notify_title")}</b>`,
      t(l, "notify_results", { value: resultsPreferenceText(l, s.results) }),
      t(l, "notify_flags", {
        alerts: onOff(l, s.alerts),
        challenges: onOff(l, s.challengeEvents),
      }),
      muted
        ? mutedLine(l, s.mutedUntil!)
        : t(l, "notify_not_muted"),
    ];
    if (notice !== undefined) lines.push("", notice);
    return {
      text: lines.join("\n"),
      keyboard: [
        // All four stored values get a button: without one for "both", anyone
        // who set it from the CLI could only leave that setting by accident.
        [
          button(t(l, "btn_results_per_match"), { panel: "notify", action: "results", arg: "per_match" }),
          button(t(l, "btn_results_daily"), { panel: "notify", action: "results", arg: "daily" }),
          button(t(l, "btn_results_both"), { panel: "notify", action: "results", arg: "both" }),
          button(t(l, "btn_results_off"), { panel: "notify", action: "results", arg: "off" }),
        ],
        muted
          ? [button(t(l, "btn_unmute"), { panel: "notify", action: "mute", arg: "off" })]
          : [
              button(t(l, "btn_mute_hour"), { panel: "notify", action: "mute", arg: "1h" }),
              button(t(l, "btn_mute_today"), { panel: "notify", action: "mute", arg: "today" }),
            ],
        [
          button(
            s.alerts ? t(l, "btn_alerts_off") : t(l, "btn_alerts_on"),
            { panel: "notify", action: "alerts", arg: s.alerts ? "off" : "on" },
          ),
          button(
            s.challengeEvents ? t(l, "btn_challenges_off") : t(l, "btn_challenges_on"),
            { panel: "notify", action: "challenges", arg: s.challengeEvents ? "off" : "on" },
          ),
        ],
        [homeButton(l)],
      ],
    };
  }

  function settingsPanel(notice?: string): Panel {
    const l = locale();
    const config = deps.config();
    const current = config.autoDailyLimit ?? 0;
    const lines = [
      `⚙️ <b>${t(l, "settings_title")}</b>`,
      t(l, "settings_daily_current", { limit: current }),
      t(l, "settings_language", { language: l === "zh" ? "中文" : "English" }),
    ];
    if (notice !== undefined) lines.push("", notice);
    return {
      text: lines.join("\n"),
      keyboard: [
        [0, 1, 2, 3, 5, 10].map((n) =>
          button(n === current ? `• ${n}` : String(n), { panel: "settings", action: "ask_daily", arg: String(n) }),
        ),
        [
          button(t(l, "btn_custom"), { panel: "settings", action: "custom_daily" }),
          button(t(l, "btn_rename"), { panel: "settings", action: "ask_rename" }),
        ],
        [button(l === "zh" ? "Switch to English" : "切换到中文", { panel: "settings", action: "locale", arg: l === "zh" ? "en" : "zh" })],
        [homeButton(l)],
      ],
    };
  }

  function duelPanel(notice?: string): Panel {
    const l = locale();
    const lines = [`⚔️ <b>${t(l, "duel_title")}</b>`, t(l, "duel_body")];
    if (notice !== undefined) lines.push("", notice);
    return {
      text: lines.join("\n"),
      keyboard: [
        PLAYABLE_GAMES.map((game) => button(gameName(l, game), { panel: "duel", action: "ask_create", arg: game })),
        [homeButton(l)],
      ],
    };
  }

  function linksPanel(): Panel {
    const l = locale();
    const config = deps.config();
    const base = config.baseUrl.replace(/\/+$/, "");
    const replay = deps.lastReplayUrl?.();
    const secondRow = [
      { text: t(l, "btn_leaderboard"), url: `${base}/leaderboard` },
      ...(replay !== undefined ? [{ text: t(l, "btn_last_replay"), url: replay }] : []),
    ];
    return {
      text: `🔗 <b>${t(l, "links_title")}</b>`,
      keyboard: [
        [
          { text: t(l, "btn_agent_page"), url: `${base}/agents/${encodeURIComponent(config.agentId)}` },
          { text: t(l, "btn_dashboard"), url: `${base}/dashboard` },
        ],
        secondRow,
        [homeButton(l)],
      ],
    };
  }

  function confirmPanel(question: string, action: CallbackData, backPanel: string): Panel {
    const l = locale();
    return {
      text: question,
      keyboard: [[
        button(t(l, "btn_confirm"), action),
        button(t(l, "btn_cancel"), { panel: backPanel, action: "open" }),
      ]],
    };
  }

  function dailyConfirmPanel(limit: number): Panel {
    const l = locale();
    const nonce = nonces.issue(`settings:daily:${limit}`);
    const question = dailyCapNeedsConfirm(limit)
      ? t(l, "confirm_daily_high", { limit, threshold: DAILY_CAP_CONFIRM_THRESHOLD })
      : t(l, "confirm_daily", { limit });
    return confirmPanel(question, { panel: "settings", action: "daily", arg: String(limit), nonce }, "settings");
  }

  // ── helpers ────────────────────────────────────────────────────────

  function connectionLine(l: NotifyLocale): string {
    const snapshot = safe(() => deps.runner?.connectionSnapshot() ?? null, null);
    if (snapshot === null) return t(l, "conn_unknown");
    if (snapshot.state === "connected") {
      const since = snapshot.connectedAt === null ? "" : ` · ${formatDuration(l, now() - snapshot.connectedAt)}`;
      return `${t(l, "conn_online")}${since}`;
    }
    return t(l, "conn_offline", { state: connectionStateText(l, snapshot.state) });
  }

  /** "Muted until 00:00" is the truth said badly — it reads as already lapsed. */
  function mutedLine(l: NotifyLocale, until: number): string {
    const midnight = new Date(now());
    midnight.setHours(24, 0, 0, 0);
    if (until === midnight.getTime()) return t(l, "notify_muted_today");
    return t(l, "notify_muted_until", { time: formatClock(until) });
  }

  function phaseLabel(l: NotifyLocale): string {
    const phase = safe(() => deps.runner?.snapshot()?.state?.phase, undefined);
    switch (phase) {
      case undefined:
      case "idle":
        return t(l, "phase_idle");
      case "matching":
      case "confirming":
        return t(l, "phase_matching");
      case "in_match":
      case "deciding":
      case "reporting":
        return t(l, "phase_in_match");
      default:
        return escapeHtml(phase);
    }
  }

  /** Turn a server refusal into a sentence, keeping the server's own wording —
   *  it is the part that says what to do (cooldown ends at…, agent offline…). */
  function actionFailure(l: NotifyLocale, cause: unknown): string {
    if (cause instanceof AgentActionError) {
      return t(l, "action_failed", { reason: escapeHtml(cause.message) });
    }
    return t(l, "action_failed", { reason: escapeHtml(describe(cause)) });
  }

  /** Run a runner action, translating its refusals into words for the chat. */
  function tryRunner(action: () => void): string | null {
    const l = locale();
    if (deps.runner === null) return t(l, "runner_unavailable");
    try {
      action();
      return null;
    } catch (cause) {
      const message = describe(cause);
      if (/already in or entering a match/i.test(message)) return t(l, "runner_busy");
      if (/not started/i.test(message)) return t(l, "runner_unavailable");
      return t(l, "runner_failed", { reason: escapeHtml(message) });
    }
  }

  async function fetchAgentStatus(): Promise<{ gamesToday: number; maxGamesPerDay: number } | null> {
    const config = deps.config();
    try {
      const res = await fetchNoFollow(
        `${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/status`,
        { method: "GET", headers: { "X-API-Key": config.apiKey }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) },
        { fetchImpl: deps.fetchImpl },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      return {
        gamesToday: typeof body.games_today === "number" ? body.games_today : 0,
        maxGamesPerDay: typeof body.max_games_per_day === "number" ? body.max_games_per_day : 0,
      };
    } catch {
      return null; // the panel says "unavailable" rather than failing to open
    }
  }

  async function fetchRatings(): Promise<Array<{ game: string; rating: number }>> {
    const config = deps.config();
    try {
      const res = await fetchNoFollow(
        `${config.baseUrl.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(config.agentId)}/profile`,
        { method: "GET", signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) },
        { fetchImpl: deps.fetchImpl },
      );
      if (!res.ok) return [];
      const body = (await res.json()) as { ratings?: unknown };
      if (!Array.isArray(body.ratings)) return [];
      return body.ratings
        .map((entry) => entry as Record<string, unknown>)
        .filter((r) => typeof r.game === "string" && typeof r.rating === "number" && (r.games_played as number) > 0)
        // display_rating is what the website, the desktop app and `aifight
        // record` show; the raw Glicko rating sits 2×RD above it.
        .map((r) => ({
          game: r.game as string,
          rating: (typeof r.display_rating === "number" ? r.display_rating : r.rating) as number,
        }));
    } catch {
      return [];
    }
  }

  async function send(chatId: number, text: string, opts: { forceReply?: boolean } = {}): Promise<void> {
    try {
      await deps.api.sendMessage({
        chatId,
        text,
        disablePreview: true,
        ...(opts.forceReply === true ? { forceReply: true } : {}),
      });
    } catch (cause) {
      logSendFailure(cause);
    }
  }

  async function sendPanel(chatId: number, panel: Panel): Promise<void> {
    try {
      await deps.api.sendMessage({ chatId, text: panel.text, keyboard: panel.keyboard, disablePreview: true });
    } catch (cause) {
      logSendFailure(cause);
    }
  }

  async function edit(chatId: number, messageId: number, panel: Panel): Promise<void> {
    try {
      await deps.api.editMessageText({ chatId, messageId, text: panel.text, keyboard: panel.keyboard });
    } catch (cause) {
      // "message is not modified" is Telegram telling us the user tapped the
      // panel they are already looking at — not a failure worth reporting.
      if (/not modified/i.test(describe(cause))) return;
      logSendFailure(cause);
      // Anything else — typically "message to edit not found" after the user
      // cleared the chat history — leaves a button tap visibly dead, so fall
      // back to a fresh panel message instead of leaving nothing at all.
      await sendPanel(chatId, panel);
    }
  }

  function logSendFailure(cause: unknown): void {
    deps.onLog?.({ level: "warning", code: "telegram.panel_failed", message: describe(cause) });
  }

  return {
    handleUpdate: async (update) => {
      try {
        await handle(update);
      } catch (cause) {
        deps.onLog?.({ level: "warning", code: "telegram.panel_error", message: describe(cause) });
      }
    },
  };
}

function button(text: string, data: CallbackData): { text: string; callback_data: string } {
  return { text, callback_data: encodeCallback(data) };
}

function homeButton(l: NotifyLocale): { text: string; callback_data: string } {
  return button(t(l, "btn_home"), { panel: "home", action: "open" });
}

function asGame(raw: string | undefined): SupportedGame | null {
  return PLAYABLE_GAMES.includes(raw as SupportedGame) ? (raw as SupportedGame) : null;
}

function dropMute(section: BridgeTelegramConfig): BridgeTelegramConfig {
  const { mutedUntil: _cleared, ...rest } = section;
  return rest;
}

function onOff(l: NotifyLocale, value: boolean): string {
  return value ? t(l, "word_on") : t(l, "word_off");
}

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(l: NotifyLocale, ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return t(l, "duration_minutes", { minutes });
  return t(l, "duration_hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
