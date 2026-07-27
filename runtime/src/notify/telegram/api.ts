// A thin Telegram Bot API client — seven endpoints, native fetch, no SDK.
//
// Why no dependency: the Bot API is plain HTTPS+JSON, this client is under 200
// lines, and the CLI is an open-source package a user installs to run next to
// their own API keys. One more transitive dependency tree is a worse trade than
// the code below.
//
// The bot token sits in the URL PATH, so no error message, log line, or thrown
// Error may ever carry the request URL. Everything here is built from the HTTP
// status and Telegram's own `description` instead.

import { fetchNoFollow } from "../../net/guarded-fetch";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Ordinary calls. The long poll computes its own from the poll window. */
const DEFAULT_TIMEOUT_MS = 15_000;

export type TelegramErrorKind =
  /** Token is wrong, revoked, or the bot was deleted — retrying cannot help. */
  | "auth"
  /** 429; `retryAfterMs` says how long Telegram wants us to wait. */
  | "rate_limit"
  /** Malformed request or a chat we may not post to (400/403) — our bug or the
   *  user blocked the bot; retrying the same call cannot help. */
  | "request"
  | "server"
  | "network"
  | "aborted";

export class TelegramApiError extends Error {
  override readonly name = "TelegramApiError";
  readonly kind: TelegramErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: TelegramErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }

  /** Would trying again, later, plausibly work? */
  get retriable(): boolean {
    return this.kind === "rate_limit" || this.kind === "server" || this.kind === "network";
  }
}

// ── Wire types (only the fields this client actually reads) ──────────

export interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly first_name?: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly date?: number;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

/** One inline-keyboard button. Exactly one of callback_data / url is used. */
export interface TelegramInlineButton {
  readonly text: string;
  readonly callback_data?: string;
  readonly url?: string;
}

export type TelegramInlineKeyboard = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

export interface SendMessageParams {
  readonly chatId: number;
  readonly text: string;
  readonly keyboard?: TelegramInlineKeyboard;
  readonly disablePreview?: boolean;
  /** Ask Telegram to pre-open the reply box, for the two places that take
   *  free text (a custom daily cap, a new display name). */
  readonly forceReply?: boolean;
}

export interface SendPhotoParams {
  readonly chatId: number;
  readonly photoUrl: string;
  readonly caption?: string;
  readonly keyboard?: TelegramInlineKeyboard;
}

export interface EditMessageTextParams {
  readonly chatId: number;
  readonly messageId: number;
  readonly text: string;
  readonly keyboard?: TelegramInlineKeyboard;
}

export interface GetUpdatesParams {
  readonly offset?: number;
  /** Long-poll window in SECONDS (Telegram's own unit). 0 = return at once. */
  readonly timeoutSec: number;
  readonly signal?: AbortSignal;
}

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<TelegramMessage>;
  sendPhoto(params: SendPhotoParams): Promise<TelegramMessage>;
  editMessageText(params: EditMessageTextParams): Promise<void>;
  answerCallbackQuery(params: { readonly id: string; readonly text?: string }): Promise<void>;
  setMyCommands(commands: readonly TelegramBotCommand[]): Promise<void>;
}

export interface TelegramApiOptions {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** Timeout for ordinary (non-long-poll) calls. */
  readonly timeoutMs?: number;
}

export function createTelegramApi(opts: TelegramApiOptions): TelegramApi {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    overrides: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    const budget = overrides.timeoutMs ?? timeoutMs;
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), budget);
    const signal = overrides.signal === undefined
      ? timer.signal
      : AbortSignal.any([timer.signal, overrides.signal]);

    let response: Response;
    try {
      response = await fetchNoFollow(
        `${TELEGRAM_API_BASE}/bot${opts.token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal,
        },
        { fetchImpl: opts.fetchImpl },
      );
    } catch (cause) {
      // The caller aborting is a normal shutdown, not a failure to report.
      if (overrides.signal?.aborted === true) {
        throw new TelegramApiError("aborted", `${method} aborted`);
      }
      if (timer.signal.aborted) {
        throw new TelegramApiError("network", `${method} timed out after ${budget} ms`);
      }
      // Deliberately not `${cause}` — a fetch failure can embed the request URL,
      // and the URL contains the bot token.
      throw new TelegramApiError("network", `${method} could not reach Telegram`);
    } finally {
      clearTimeout(handle);
    }

    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }
      | undefined;

    if (!response.ok || body?.ok !== true) {
      const description = typeof body?.description === "string" ? body.description : `HTTP ${response.status}`;
      const retryAfterSec = body?.parameters?.retry_after;
      throw new TelegramApiError(classify(response.status), `${method}: ${description}`, {
        status: response.status,
        ...(typeof retryAfterSec === "number" ? { retryAfterMs: Math.max(0, retryAfterSec) * 1000 } : {}),
      });
    }
    return body.result as T;
  }

  return {
    getMe: () => call<TelegramUser>("getMe", {}),

    getUpdates: (params) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        {
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          timeout: params.timeoutSec,
          // Anything else (edited messages, channel posts, my_chat_member…) is
          // noise this companion has no use for; not asking for it keeps the
          // queue small and the surface narrow.
          allowed_updates: ["message", "callback_query"],
        },
        {
          // The HTTP call must outlive the long-poll window itself.
          timeoutMs: (params.timeoutSec + 15) * 1000,
          ...(params.signal !== undefined ? { signal: params.signal } : {}),
        },
      ),

    sendMessage: (params) =>
      call<TelegramMessage>("sendMessage", {
        chat_id: params.chatId,
        text: params.text,
        parse_mode: "HTML",
        ...(params.disablePreview === true ? { link_preview_options: { is_disabled: true } } : {}),
        ...(params.keyboard !== undefined
          ? { reply_markup: { inline_keyboard: params.keyboard } }
          : params.forceReply === true
            ? { reply_markup: { force_reply: true } }
            : {}),
      }),

    sendPhoto: (params) =>
      call<TelegramMessage>("sendPhoto", {
        chat_id: params.chatId,
        photo: params.photoUrl,
        ...(params.caption !== undefined ? { caption: params.caption, parse_mode: "HTML" } : {}),
        ...(params.keyboard !== undefined ? { reply_markup: { inline_keyboard: params.keyboard } } : {}),
      }),

    editMessageText: async (params) => {
      await call<unknown>("editMessageText", {
        chat_id: params.chatId,
        message_id: params.messageId,
        text: params.text,
        parse_mode: "HTML",
        ...(params.keyboard !== undefined ? { reply_markup: { inline_keyboard: params.keyboard } } : {}),
      });
    },

    answerCallbackQuery: async (params) => {
      await call<unknown>("answerCallbackQuery", {
        callback_query_id: params.id,
        ...(params.text !== undefined ? { text: params.text } : {}),
      });
    },

    setMyCommands: async (commands) => {
      await call<unknown>("setMyCommands", { commands });
    },
  };
}

function classify(status: number): TelegramErrorKind {
  // 404 is how a wrong token presents: the /bot<token>/… path does not exist.
  if (status === 401 || status === 404) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "request";
}

/** Escape user- or server-supplied text for parse_mode: "HTML".
 *  Telegram only needs these three; escaping more would show up as literal
 *  entities in the message. */
export function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
