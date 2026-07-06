// @aifight/aifight — public entry point.
//
// M1-01 ships the minimum observable surface:
//   - every protocol TypeScript type (re-exported from the codegen'd
//     types.ts copy — same bytes as protocol/tools/generated/types.ts)
//   - a schema loader (messages dispatch + full tree walk)
//   - a hello() self-test for use by `aifight doctor` and CI
//
// Everything else (WS client, FSM, decision providers, scheduler,
// CLI commands beyond --version) ships in later M1 tasks.

export * from "./protocol/types";
export {
  findSchemasRoot,
  loadSchema,
  loadAllSchemas,
  loadRestSchema,
  messageTypes,
  type MessageType,
  type RestSchemaName,
} from "./protocol/schemas";
export {
  registerAgent,
  type RegisterAgentOptions,
  type RegisterAgentResult,
} from "./account/registration";
export {
  RegisterError,
  RegisterNetworkError,
  RegisterHttpError,
  RegisterSchemaError,
  type RegisterErrorKind,
  type AjvLikeError,
} from "./account/errors";
export {
  openDatabase,
  type OpenDatabaseOptions,
  type StoreHandle,
  type AgentRow,
  type UpsertAgentInput,
} from "./store/sqlite";
export {
  getRuntimeHome,
  getDefaultDbPath,
  ensureRuntimeHome,
} from "./store/paths";
export {
  StoreError,
  StoreOpenError,
  StoreMigrationError,
  StoreQueryError,
  type StoreErrorKind,
} from "./store/errors";
// M1-05: credentials encryption API. resetCredentialsBackendCacheForTests
// is intentionally NOT re-exported — it is a test-only helper and
// must stay unreachable from the public surface.
export {
  AIFIGHT_KEYCHAIN_V1_PREFIX,
  AIFIGHT_CRYPTO_V1_PREFIX,
  AIFIGHT_RUNTIME_SERVICE,
  encryptForStorage,
  decryptFromStorage,
  deleteFromStorage,
  isKeychainAvailable,
  getCredentialsBackend,
  type CredentialsBackendInfo,
} from "./account/credentials";
export {
  CredentialsError,
  CredentialsKeychainUnavailableError,
  CredentialsCryptoError,
  CredentialsCorruptError,
  type CredentialsErrorKind,
} from "./account/errors";
// M1-06: WebSocket client + framing layer. Connect to aifight.ai/api/ws
// with X-API-Key auth, drive the protocol message loop, surface inbound
// frames + close lifecycle to the caller via handler registries.
//
// CRITICAL: WSClient is a TYPE-ONLY export. The implementation class
// WSClientImpl is module-private inside ./wsclient/client.ts; the only
// way to obtain a WSClient instance is via createWSClient() (Step 4b
// contract). Holding a WSClient means a server-confirmed welcome
// happened. Do NOT change `export type { WSClient }` to
// `export { WSClient }` — see tests/index-exports.test.ts for the
// runtime guard that traps that regression.
export { createWSClient } from "./wsclient/client";
export type {
  WSClient,
  WSClientMessage,
  WSClientOptions,
  WSWelcome,
  WSCloseInfo,
  WSMessageHandler,
  WSErrorHandler,
  WSCloseHandler,
} from "./wsclient/client";
export type { ServerMessageEnvelope } from "./wsclient/frame-handler";
// 11 error classes (Step 5b2 Directive). WSClientError is `abstract` in
// TypeScript (so `new WSClientError(...)` won't compile) but it is
// still a runtime class value at the JS level — callers use it for
// `instanceof` checks across the whole error hierarchy.
export {
  WSClientError,
  WSConnectError,
  WSHandshakeError,
  WSWelcomeTimeoutError,
  WSWelcomeInvalidError,
  WSProtocolVersionError,
  WSClosedError,
  WSSchemaError,
  WSOutboundSchemaError,
  WSUnknownMessageError,
  WSAbortedError,
} from "./wsclient/errors";
export type { WSClientErrorKind } from "./wsclient/errors";
// M1-07b: reconnect facade public package boundary. M1-07 intentionally
// landed reconnect.ts as source-only so its internals could be reviewed
// without touching the package surface. This block is the only supported
// import path for reconnect APIs; do not add package.json subpaths.
export {
  createReconnectingWSClient,
  ReconnectStoppedError,
} from "./wsclient/reconnect";
export type {
  ReconnectingWSClient,
  ReconnectingWSClientOptions,
  ReconnectEvent,
  ReconnectEventHandler,
  ReconnectCloseInfo,
  ReconnectCloseHandler,
  ReconnectStopReason,
  JitterStrategy,
} from "./wsclient/reconnect";
// M1-14: decision provider facade — composes M1-12 prompt-builder +
// M1-11 direct-model HTTP clients + M1-14 per-game LLM action parsers
// + retry budget + M1-13 fallback dispatch into the plan §5.5
// DecisionProvider interface. createDirectModelProvider is the first
// concrete factory (Anthropic + OpenAI). DecisionProviderError is the
// concrete error class consumers catch (4 fatal kinds via the
// `kind` discriminator; retriable errors are consumed internally by
// the retry → fallback path and never leak).
//
// Internal building blocks intentionally stay internal — consumers
// should reach them through the facade:
//   - DirectModelError 5 classes (M1-11) — wrapped as
//     DecisionProviderError; underlying instance still reachable via
//     `error.cause` for debugging (rev3 fix #6 lock 选 B).
//   - createAnthropicClient / createOpenAIClient (M1-11) — driven by
//     createDirectModelProvider; opts.clientFactory injects mocks.
//   - buildPrompt / formatXState / fallbackX / parseXAction
//     (M1-12 / M1-13 / M1-14) — facade orchestrates all of them.
//
// DirectModelProviderName comes from the M1-11 sealed
// ./direct-model/types module but is re-exported through provider.ts
// so callers reach a single surface origin.
export {
  createDirectModelProvider,
  DecisionProviderError,
} from "./decision/provider";
export type {
  DecisionProvider,
  DirectModelProviderOptions,
  DirectModelProviderName,
  DecisionProviderErrorKind,
} from "./decision/provider";
export type {
  DecisionRequest,
  DecisionResponse,
  DecisionResponseProviderMetadata,
  StrategyProfile,
  GameSpecificProfile,
  GameType,
  GameRules,
  LegalAction,
} from "./decision/types";
export {
  DECISION_PROTOCOL_VERSION,
  DecisionProtocolResponseError,
  buildDecisionProtocolRequest,
  readDecisionProtocolAction,
} from "./decision/protocol";
export type {
  BuildDecisionProtocolRequestOptions,
  DecisionProtocolRequest,
  DecisionProtocolResponse,
  DecisionProtocolStrategySection,
} from "./decision/protocol";
export type {
  ParseResult,
  ParseInvalidReason,
} from "./decision/parser-types";

import { loadAllSchemas, messageTypes } from "./protocol/schemas";

// Version mirrors package.json. Hand-sync'd, enforced at publish time by
// scripts/verify-version-sync.mjs (prepublishOnly) and rechecked in vitest.
export const RUNTIME_VERSION = "0.1.0-beta.11";
// Mirrors protocol/VERSION. v1.2: action_request.request_id echo +
// action_stale (F07/R3-01). Declared to the server on connect via the
// X-AIFight-Protocol-Version header so it knows our schemas accept the
// additive request_id field.
export const PROTOCOL_VERSION = "v1.2.0";

export interface HelloResult {
  ok: true;
  runtimeVersion: string;
  schemaCount: number;
  messageTypeCount: number;
  schemasRoot: string;
}

import { findSchemasRoot } from "./protocol/schemas";

export function hello(): HelloResult {
  // Resolve the filesystem path first — this is the exact path a
  // misdirected packaging / install would expose. `aifight doctor`
  // displays this so an operator can pinpoint "did the schemas
  // asset tree ship into this package" without having to inspect
  // node_modules by hand.
  const schemasRoot = findSchemasRoot();
  const all = loadAllSchemas();
  const types = messageTypes();
  return {
    ok: true,
    runtimeVersion: RUNTIME_VERSION,
    schemaCount: all.size,
    messageTypeCount: types.length,
    schemasRoot,
  };
}
