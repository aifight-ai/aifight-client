import {
  defaultRuntimeLocalUrl,
  defaultRuntimeModel,
  wsUrlIsValid,
  type BridgeConfig,
  type BridgeRuntimeType,
} from "./config";

export interface BridgePairExchangeResponse {
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly api_key: string;
    readonly runtime_type: string;
  };
  readonly ws_url: string;
  readonly message?: string;
}

export interface ExchangePairingCodeOptions {
  readonly pairingCode: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  /** Per-device id; sent as X-Device-Id so the server rebinds the agent to THIS
   *  machine on a successful exchange. Omitted from the request when absent. */
  readonly deviceId?: string;
}

const DEFAULT_BASE_URL = "https://aifight.ai";

export async function exchangePairingCode(
  opts: ExchangePairingCodeOptions,
): Promise<BridgeConfig> {
  const pairingCode = opts.pairingCode.trim();
  if (pairingCode === "") {
    throw new Error("pairing code is required");
  }

  const baseUrl = normalizeBaseUrl(
    opts.baseUrl ?? process.env.AIFIGHT_BASE_URL ?? DEFAULT_BASE_URL,
  );
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(`${baseUrl}/api/bridge/pair`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.deviceId ? { "X-Device-Id": opts.deviceId } : {}),
    },
    body: JSON.stringify({ pairing_code: pairingCode }),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    throw new Error(message);
  }

  const body = (await res.json()) as unknown;
  const typed = parsePairExchangeResponse(body);
  // SECURITY: the agent API key is sent in the WS upgrade header, so never trust
  // the server-supplied ws_url blindly. It must stay on the same host we paired
  // with and (in production) use wss:// — no plaintext or cross-host downgrade.
  if (!wsUrlIsValid(typed.ws_url, baseUrl)) {
    throw new Error(
      `the server returned an unsafe WebSocket URL (${typed.ws_url}); refusing to pair`,
    );
  }
  // Every agent plays via direct-LLM in this build. Legacy agents may report a
  // non-direct runtime_type from the server; coerce anything but mock to direct.
  const runtimeType: BridgeRuntimeType = typed.agent.runtime_type === "mock" ? "mock" : "direct";
  const now = opts.now ?? (() => new Date());

  return {
    version: 1,
    baseUrl,
    wsUrl: typed.ws_url,
    agentId: typed.agent.id,
    agentName: typed.agent.name,
    apiKey: typed.agent.api_key,
    runtimeType,
    runtimeLocalUrl: defaultRuntimeLocalUrl(runtimeType),
    runtimeModel: defaultRuntimeModel(runtimeType),
    ...(runtimeType === "direct" ? { directAgentSlug: "default" } : {}),
    updatedAt: now().toISOString(),
  };
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

async function readErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => undefined) as unknown;
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return `pairing failed with HTTP ${res.status}`;
}

function parsePairExchangeResponse(body: unknown): BridgePairExchangeResponse {
  if (!body || typeof body !== "object") {
    throw new Error("pairing response was not an object");
  }
  const root = body as Record<string, unknown>;
  const agent = root.agent;
  if (!agent || typeof agent !== "object") {
    throw new Error("pairing response missing agent");
  }
  const a = agent as Record<string, unknown>;
  if (
    typeof a.id !== "string" ||
    typeof a.name !== "string" ||
    typeof a.api_key !== "string" ||
    typeof a.runtime_type !== "string" ||
    typeof root.ws_url !== "string"
  ) {
    throw new Error("pairing response had invalid fields");
  }
  return {
    agent: {
      id: a.id,
      name: a.name,
      api_key: a.api_key,
      runtime_type: a.runtime_type,
    },
    ws_url: root.ws_url,
    ...(typeof root.message === "string" ? { message: root.message } : {}),
  };
}
