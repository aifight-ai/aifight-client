// HTTP client wrapper for the M1-16 control API.
//
// Native fetch (Node 20.19+); zero new runtime deps. Internal-only — not
// re-exported from runtime/src/index.ts. CLI consumers (bin/aifight.ts via
// Step 3 main.ts) wire this up at request time.
//
// rev2 fix #2 — DOES NOT import from "../controlapi/types". M1-16
// types.ts file header explicitly states: "CLI is HTTP consumer; they do
// NOT import these types directly". The 9-code union is duplicated here as
// a string-literal union; if M1-16 server adds a code, the local guard
// fails to recognise it and the client maps to `transport_unparseable`
// (exit 12) — the documented contract-drift signal.
//
// rev2 fix #4 + rev4 fix #1 — `createControlClient` is pure-lazy: it does
// NOT invoke `tokenSource()` or `portSource()` at construction. Sources
// are invoked at the first request (and re-invoked on 401 retry). Any
// `RuntimeFilesError` raised by sources MUST be caught at the request-path
// boundary and wrapped by `kind` into ControlClientError. Raw
// RuntimeFilesError MUST NOT cross this boundary (rev3 fix #1).
//
// rev3 fix #2 — `request_timeout` is a distinct kind (not catchall);
// implemented via AbortController + setTimeout(baseTimeoutMs).

import { RuntimeFilesError } from "./runtime-files";

// ── Local 9-code mirror of M1-16 ControlErrorCode (rev2 fix #2) ────────

export type ControlErrorCodeLocal =
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "bad_request"
  | "unsupported_media_type"
  | "payload_too_large"
  | "not_implemented"
  | "service_unavailable"
  | "internal_error";

const CONTROL_ERROR_CODES: ReadonlySet<ControlErrorCodeLocal> = new Set<
  ControlErrorCodeLocal
>([
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "bad_request",
  "unsupported_media_type",
  "payload_too_large",
  "not_implemented",
  "service_unavailable",
  "internal_error",
]);

export function isControlErrorCode(x: unknown): x is ControlErrorCodeLocal {
  return (
    typeof x === "string" &&
    CONTROL_ERROR_CODES.has(x as ControlErrorCodeLocal)
  );
}

export interface ControlErrorBodyLocal {
  readonly error: {
    readonly code: ControlErrorCodeLocal;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export function isControlErrorBody(x: unknown): x is ControlErrorBodyLocal {
  if (typeof x !== "object" || x === null) return false;
  const err = (x as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return isControlErrorCode(e.code) && typeof e.message === "string";
}

// ── ControlClientError 6-kind (rev3 fix #2 final taxonomy) ─────────────

export type ControlClientErrorKind =
  | "daemon_unreachable"
  | "runtime_files_corrupt"
  | "auth_failed"
  | "request_timeout"
  | "server_error"
  | "transport_unparseable";

export interface ControlClientErrorInit {
  readonly serverCode?: ControlErrorCodeLocal;
  readonly status?: number;
  readonly body?: unknown;
  readonly cause?: unknown;
}

export class ControlClientError extends Error {
  override readonly name = "ControlClientError";
  readonly kind: ControlClientErrorKind;
  readonly serverCode?: ControlErrorCodeLocal;
  readonly status: number;
  readonly body?: unknown;
  override readonly cause?: unknown;
  constructor(
    kind: ControlClientErrorKind,
    message: string,
    init?: ControlClientErrorInit,
  ) {
    super(message);
    this.kind = kind;
    this.serverCode = init?.serverCode;
    this.status = init?.status ?? 0;
    this.body = init?.body;
    this.cause = init?.cause;
  }
}

// ── Public client surface ──────────────────────────────────────────────

export interface ControlClient {
  /** GET <path>. Returns parsed JSON body. 4xx/5xx → throw ControlClientError. */
  get<T = unknown>(path: string): Promise<T>;
  /** POST <path> with body.
   *  - body === undefined → no Content-Type / no payload (use this for
   *    /shutdown, /pause, /resume, /leave).
   *  - body === null → Content-Type: application/json + literal "null".
   *  - object → Content-Type: application/json + JSON.stringify. */
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** DELETE <path>. */
  delete<T = unknown>(path: string): Promise<T>;
}

export interface CreateControlClientOptions {
  /** Sync, lazy — invoked at the moment of each request, NOT at client
   *  construction. Construction MUST succeed even if the source would
   *  throw, so bridge-independent commands (version / --help / doctor)
   *  can construct a client without a running Bridge. */
  readonly tokenSource: () => string;
  /** Same lazy semantics + same wrap-at-boundary contract as tokenSource. */
  readonly portSource: () => number;
  /** Default "127.0.0.1". */
  readonly host?: string;
  /** Per-request timeout. Default 10000 ms. */
  readonly baseTimeoutMs?: number;
  /** Injectable for tests. Default globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Optional log hook (rebootstrap reason etc.). MUST NOT receive token. */
  readonly onLog?: (event: { code: string; message: string }) => void;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 10000;

export function createControlClient(
  opts: CreateControlClientOptions,
): ControlClient {
  const host = opts.host ?? DEFAULT_HOST;
  const baseTimeoutMs = opts.baseTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  // Cache populated on first successful invoke; refreshed on 401 retry.
  let cachedToken: string | undefined;
  let cachedPort: number | undefined;

  // ── helpers (closure) ────────────────────────────────────────────────

  /** Wraps RuntimeFilesError → ControlClientError by `kind` discriminator
   *  (rev3 fix #1). Callers pre-narrow with `instanceof RuntimeFilesError`
   *  and re-throw any other error unchanged for the catchall funnel. */
  function wrapRuntimeFilesError(e: RuntimeFilesError): ControlClientError {
    if (e.kind === "token_missing" || e.kind === "port_missing") {
      return new ControlClientError(
        "daemon_unreachable",
        `AIFight Bridge not running: ${e.message}`,
        { cause: e },
      );
    }
    return new ControlClientError(
      "runtime_files_corrupt",
      `corrupt runtime files: ${e.message}`,
      { cause: e },
    );
  }

  /** First-invoke: returns cached values when available, otherwise lazy
   *  invokes both sources and caches successful values. RuntimeFilesError
   *  is wrapped by `kind` into ControlClientError per rev3 fix #1 — raw
   *  RuntimeFilesError MUST NOT cross this boundary. */
  function getCachedOrInvoke(): { token: string; port: number } {
    if (cachedToken !== undefined && cachedPort !== undefined) {
      return { token: cachedToken, port: cachedPort };
    }
    try {
      const token = opts.tokenSource();
      const port = opts.portSource();
      cachedToken = token;
      cachedPort = port;
      return { token, port };
    } catch (e) {
      if (e instanceof RuntimeFilesError) throw wrapRuntimeFilesError(e);
      throw e;
    }
  }

  /** 401 retry path: force re-invoke both sources, refresh cache, return
   *  whether either value changed compared to the previous cached value.
   *  RuntimeFilesError on the reread path is wrapped just like the
   *  first-invoke path (the 401 retry MUST NOT leak raw RuntimeFilesError). */
  function rereadOrThrow(): {
    token: string;
    port: number;
    changed: boolean;
  } {
    const oldToken = cachedToken;
    const oldPort = cachedPort;
    try {
      const token = opts.tokenSource();
      const port = opts.portSource();
      cachedToken = token;
      cachedPort = port;
      return {
        token,
        port,
        changed: token !== oldToken || port !== oldPort,
      };
    } catch (e) {
      if (e instanceof RuntimeFilesError) throw wrapRuntimeFilesError(e);
      throw e;
    }
  }

  // Duck-type by `name === "AbortError"` (Step 2b — Codex P2 fix). The
  // value reaching this catch can be a vanilla Error subclass, a DOMException
  // (Node 22 fetch body-stream errors), or a structured-clone-like wrap;
  // they all set `.name = "AbortError"` but are not all `instanceof Error`.
  function isAbortError(e: unknown): boolean {
    if (typeof e !== "object" || e === null) return false;
    return (e as { name?: unknown }).name === "AbortError";
  }

  /** Build init for fetch, distinguishing body=undefined / null / object. */
  function buildInit(
    method: string,
    body: unknown,
    token: string,
    signal: AbortSignal,
  ): RequestInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    let payload: string | undefined;
    if (body === undefined) {
      payload = undefined;
    } else {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return {
      method,
      headers,
      body: payload,
      signal,
    };
  }

  interface ExecResult {
    readonly status: number;
    readonly parsedBody: unknown;
    readonly parseFailed: boolean;
  }

  async function executeOnce(
    method: string,
    path: string,
    body: unknown,
    token: string,
    port: number,
  ): Promise<ExecResult> {
    const url = `http://${host}:${port}${path}`;
    const controller = new AbortController();
    const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
      controller.abort();
    }, baseTimeoutMs);
    // Step 2b — Codex P2 fix: the timeout MUST cover the entire request
    // lifecycle (fetch headers + body stream read), not only the fetch
    // headers phase. A server that ships headers fast and then stalls the
    // body stream would otherwise hang the CLI indefinitely. Single
    // try/finally clears the timer regardless of which phase succeeds /
    // fails / aborts.
    try {
      let response: Response;
      try {
        response = await fetchImpl(
          url,
          buildInit(method, body, token, controller.signal),
        );
      } catch (e) {
        if (isAbortError(e)) {
          throw new ControlClientError(
            "request_timeout",
            `request timed out after ${baseTimeoutMs}ms`,
            { cause: e },
          );
        }
        throw new ControlClientError(
          "daemon_unreachable",
          `AIFight Bridge not running: ${(e as Error).message}`,
          { cause: e },
        );
      }

      let text: string;
      try {
        text = await response.text();
      } catch (e) {
        if (isAbortError(e)) {
          // Body stream aborted by our own timeout (Step 2b — body read is
          // covered by baseTimeoutMs).
          throw new ControlClientError(
            "request_timeout",
            `request timed out after ${baseTimeoutMs}ms`,
            { cause: e },
          );
        }
        // Non-abort body read failure — treat as contract drift
        // (transport_unparseable). Do not leak raw response data.
        throw new ControlClientError(
          "transport_unparseable",
          `failed to read response body (status ${response.status})`,
          { status: response.status, cause: e },
        );
      }
      if (text.length === 0) {
        return {
          status: response.status,
          parsedBody: undefined,
          parseFailed: false,
        };
      }
      try {
        return {
          status: response.status,
          parsedBody: JSON.parse(text),
          parseFailed: false,
        };
      } catch {
        return {
          status: response.status,
          parsedBody: text,
          parseFailed: true,
        };
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  function processFinalResponse<T>(result: ExecResult): T {
    if (result.status >= 200 && result.status < 300) {
      if (result.parseFailed) {
        throw new ControlClientError(
          "transport_unparseable",
          `non-JSON success response (status ${result.status})`,
          { status: result.status, body: result.parsedBody },
        );
      }
      return result.parsedBody as T;
    }
    if (result.parseFailed || !isControlErrorBody(result.parsedBody)) {
      throw new ControlClientError(
        "transport_unparseable",
        `invalid error envelope (status ${result.status})`,
        { status: result.status, body: result.parsedBody },
      );
    }
    const env = result.parsedBody;
    throw new ControlClientError("server_error", env.error.message, {
      serverCode: env.error.code,
      status: result.status,
      body: env,
    });
  }

  async function request<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    const creds = getCachedOrInvoke();

    const r1 = await executeOnce(method, path, body, creds.token, creds.port);
    if (r1.status !== 401) {
      return processFinalResponse<T>(r1);
    }

    const reread = rereadOrThrow();
    if (!reread.changed) {
      throw new ControlClientError(
        "auth_failed",
        "token mismatch — daemon rejected the cached credentials and the token / port files have not been rotated",
        { status: 401 },
      );
    }
    if (opts.onLog) {
      opts.onLog({
        code: "rebootstrap",
        message: "rebootstrap reason=401",
      });
    }

    const r2 = await executeOnce(method, path, body, reread.token, reread.port);
    if (r2.status === 401) {
      throw new ControlClientError(
        "auth_failed",
        "token mismatch — daemon still rejected after reread + retry",
        { status: 401 },
      );
    }
    return processFinalResponse<T>(r2);
  }

  return {
    get<T>(path: string): Promise<T> {
      return request<T>("GET", path, undefined);
    },
    post<T>(path: string, body?: unknown): Promise<T> {
      return request<T>("POST", path, body);
    },
    delete<T>(path: string): Promise<T> {
      return request<T>("DELETE", path, undefined);
    },
  };
}
