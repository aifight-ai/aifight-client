// runtime/scripts/ts-consumer.ts — Step 8 TypeScript consumer smoke
//
// This file is COPIED into the scratch install dir by build.sh
// (renamed to consumer.ts) and compiled there with `tsc --noEmit`
// against `@aifight/aifight`'s published .d.ts. It is NOT included
// in runtime/tsconfig.json (the import target — `@aifight/aifight`
// — only resolves inside a directory where the tarball has been
// installed). IDE type errors on this file in dev are expected.
//
// Coverage roll-up (each block must keep working as later milestones
// land — break this file = break consumer-facing types):
//   - M1-01: hello + loadSchema + RUNTIME_VERSION + per-game type
//            narrowing (MsgGameStartDataTexasHoldem)
//   - M1-04: openDatabase + StoreHandle + AgentRow + StoreErrorKind
//   - M1-05: encryptForStorage / decryptFromStorage / deleteFromStorage
//            + isKeychainAvailable + getCredentialsBackend
//            + CredentialsError / CredentialsCorruptError
//            + CredentialsBackendInfo / CredentialsErrorKind
//   - M1-06: createWSClient (runtime fn) + 11 error class runtime
//            exports + 10 type-only exports (WSClient is type-only —
//            crucial Step 4b contract; @ts-expect-error guard below)
//   - M1-07b: createReconnectingWSClient + ReconnectStoppedError runtime
//             exports + reconnect facade type-only exports.
//
// Step 4b regression guard (THE single most important assertion in
// this file): WSClient is `export type` — it's a type alias, NOT a
// runtime class. Using it as a value (e.g. `new WSClient()`,
// `WSClient.something`) MUST be a TypeScript error. The
// `@ts-expect-error` directive below traps any future regression
// where someone accidentally wrote `export { WSClient }`. If the
// directive becomes unused, tsc fails with "Unused
// `@ts-expect-error` directive" — which IS the catch we want.
//
// Note: the backticks around `@ts-expect-error` in this comment
// block are deliberate — TypeScript parses `// @ts-expect-error`
// at line start as a real directive (TS would then expect an
// error on the next line and report TS2578 unused if it doesn't
// find one). Backticks (or any non-whitespace prefix) prevent
// that misparse.

import {
  // ─── M1-01 ────────────────────────────────────────────────────────
  hello,
  loadSchema,
  messageTypes,
  RUNTIME_VERSION,
  type MsgWelcome,
  type MsgGameStartDataTexasHoldem,
  // ─── M1-04 ────────────────────────────────────────────────────────
  openDatabase,
  type StoreHandle,
  type AgentRow,
  type StoreErrorKind,
  // ─── M1-05 ────────────────────────────────────────────────────────
  encryptForStorage,
  decryptFromStorage,
  deleteFromStorage,
  isKeychainAvailable,
  getCredentialsBackend,
  CredentialsError,
  CredentialsCorruptError,
  type CredentialsBackendInfo,
  type CredentialsErrorKind,
  // ─── M1-06 wsclient — runtime values (function + 11 error classes) ─
  createWSClient,
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
  // ─── M1-07b reconnect — runtime values ─────────────────────────────
  createReconnectingWSClient,
  ReconnectStoppedError,
  // ─── M1-06 wsclient — type-only exports ─────────────────────────────
  type WSClient,
  type WSClientMessage,
  type WSClientOptions,
  type WSWelcome,
  type ServerMessageEnvelope,
  type WSCloseInfo,
  type WSMessageHandler,
  type WSErrorHandler,
  type WSCloseHandler,
  type WSClientErrorKind,
  // ─── M1-07b reconnect — type-only exports ──────────────────────────
  type ReconnectingWSClient,
  type ReconnectingWSClientOptions,
  type ReconnectEvent,
  type ReconnectEventHandler,
  type ReconnectCloseInfo,
  type ReconnectCloseHandler,
  type ReconnectStopReason,
  type JitterStrategy,
  // ─── M1-14 decision facade — runtime values ────────────────────────
  createDirectModelProvider,
  DecisionProviderError,
  DECISION_PROTOCOL_VERSION,
  DecisionProtocolResponseError,
  buildDecisionProtocolRequest,
  readDecisionProtocolAction,
  // ─── M1-14 decision facade — type-only exports ─────────────────────
  type DecisionProvider,
  type DirectModelProviderOptions,
  type DirectModelProviderName,
  type DecisionProviderErrorKind,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionResponseProviderMetadata,
  type StrategyProfile,
  type GameSpecificProfile,
  type GameType,
  type GameRules,
  type LegalAction,
  type BuildDecisionProtocolRequestOptions,
  type DecisionProtocolRequest,
  type DecisionProtocolResponse,
  type DecisionProtocolStrategySection,
  type ParseResult,
  type ParseInvalidReason,
} from "@aifight/aifight";

// M1-14 rev3 fix #6 lock: M1-11 DirectModelError is intentionally NOT
// re-exported from @aifight/aifight — consumers wrap their catch in
// DecisionProviderError and reach the underlying instance via
// `error.cause`. If a future change accidentally added DirectModelError
// to src/index.ts, the @ts-expect-error directive becomes unused →
// tsc emits "Unused '@ts-expect-error' directive" → this file fails
// to compile → build.sh aborts with a clear signal.
//
// `import type` (not value) keeps the directive scoped to TS only —
// no runtime side effect.

// @ts-expect-error - DirectModelError must not be a public surface symbol (M1-14 rev3 lock)
import type { DirectModelError as _ForbiddenDirectModelError } from "@aifight/aifight";

// ─── M1-01: hello + per-game union narrowing ──────────────────────────
const r = hello();
const ver: string = r.runtimeVersion;
const schemas: number = r.schemaCount;

const welcome: MsgWelcome = {
  type: "welcome",
  data: {
    server_protocol_version: "v1.2.0",
    agent_id: "aaaaaaaa-0000-0000-0000-000000000001",
    agent_name: "ConsumerTest",
    server_time: "2026-04-24T00:00:00Z",
    games: ["texas_holdem"],
  },
};

// Per-game union narrowing (M0 P2-3 regression guard at the package
// boundary, not just in the dev source tree).
function accept(data: MsgGameStartDataTexasHoldem): string {
  return data.rules.name;
}

const schema = loadSchema("welcome");
const types = messageTypes();
const version: string = RUNTIME_VERSION;

// ─── M1-04: store surface ─────────────────────────────────────────────
function acceptStore(h: StoreHandle): AgentRow[] {
  return h.listAgents();
}
const kind: StoreErrorKind = "open";

// ─── M1-05: credentials surface ───────────────────────────────────────
// Exercise typed public API declarations WITHOUT calling the real
// encrypt/decrypt paths. Those would touch the OS keychain from
// inside a build-script compile step — a side effect we want to
// avoid; the library's own tests cover behavior, this smoke only
// proves .d.ts exposes the symbols consumers will see.
const credBackend: CredentialsBackendInfo = { backend: "fallback-crypto" };
const credKind: CredentialsErrorKind = "corrupt";

// ─── M1-06: wsclient surface ──────────────────────────────────────────
// 1. createWSClient is a runtime function value.
const cwc: typeof createWSClient = createWSClient;

// 2. WSClient is a TYPE — usable as a function parameter type, return
//    type, variable annotation. NOT usable as a value.
function acceptClient(c: WSClient): void {
  void c;
}

// 3. WSClientMessage strict union (Roy 2026-04-25 Step 5b2 拍板 B 路线):
//    valid envelopes compile.
const msgLeave: WSClientMessage = { type: "leave_queue" };
const msgJoin: WSClientMessage = {
  type: "join_queue",
  data: { game: "texas_holdem" },
};
const msgConfirm: WSClientMessage = {
  type: "match_confirm",
  data: { confirm_id: "00000000-0000-4000-8000-000000000010" },
};
const msgAction: WSClientMessage = {
  type: "action",
  match_id: "00000000-0000-4000-8000-000000000020",
  data: { type: "fold" },
  // REQUIRED echo (v1.2 enforcement 2026-07-16)
  request_id: "ffffffff-0000-0000-0000-000000000001",
};

// 4. WSCloseInfo / handler types compose normally.
const closeInfo: WSCloseInfo = {
  code: 1000,
  reason: "done",
  initiator: "client",
};
const onMsg: WSMessageHandler = (m) => {
  void m;
};
const onErr: WSErrorHandler = (e) => {
  void e;
};
const onClose: WSCloseHandler = (i) => {
  void i;
};
const env: ServerMessageEnvelope = { type: "welcome", data: {} };
const errKind: WSClientErrorKind = "connect";
const opts: WSClientOptions = {
  url: "wss://aifight.ai/api/ws",
  apiKey: "sk-consumer-probe",
  expectedProtocolVersion: "1.2.0",
};
const welcomeFrame: WSWelcome = {
  type: "welcome",
  data: {
    server_protocol_version: "1.2.0",
    agent_id: "aaaaaaaa-0000-0000-0000-000000000001",
    agent_name: "ConsumerTest",
    server_time: "2026-04-24T00:00:00Z",
    games: ["texas_holdem"],
  },
};

// ─── M1-07b: reconnect facade surface ───────────────────────────────
const crwc: typeof createReconnectingWSClient = createReconnectingWSClient;
const stopReason: ReconnectStopReason = "signal";
const jitter: JitterStrategy = "full";
const reconnectOptions: ReconnectingWSClientOptions = {
  url: "wss://aifight.ai/api/ws",
  apiKey: "sk-consumer-probe",
  expectedProtocolVersion: "1.2.0",
  initialBackoffMs: 1_000,
  backoffFactor: 2,
  maxBackoffMs: 30_000,
  jitter,
  maxAttempts: 3,
};
const reconnectEvent: ReconnectEvent = {
  type: "attempt-start",
  attempt: 1,
  elapsedMs: 0,
  severity: "info",
};
const onReconnect: ReconnectEventHandler = (ev) => {
  void ev;
};
const reconnectClose: ReconnectCloseInfo = {
  kind: stopReason,
};
const onReconnectClose: ReconnectCloseHandler = (info) => {
  void info;
};
function acceptReconnectClient(c: ReconnectingWSClient): void {
  c.onReconnect(onReconnect);
}
const stopErr = new ReconnectStoppedError("signal", undefined, "probe");

// ─── M1-14: decision facade surface ─────────────────────────────────
const cdmp: typeof createDirectModelProvider = createDirectModelProvider;

// DecisionProviderError is concrete (M1-14 rev3 fix #6) — `new` must
// type-check.
const dpe = new DecisionProviderError(
  "fatal_caller_bug",
  "consumer probe",
  undefined,
);
const dpeKind: DecisionProviderErrorKind = dpe.kind;

const dmpName: DirectModelProviderName = "anthropic";
const dmpName2: DirectModelProviderName = "openai";

const stratProfile: StrategyProfile = {
  name: "consumer-bot",
  version: 1,
  provider: "anthropic",
  model: "claude-opus-4-7",
  systemPrompt: "you are an anchor",
  maxTokens: 1024,
};
const gsp: GameSpecificProfile = { extraPrompt: "be terse" };
const game: GameType = "coup";
const rules: GameRules = {
  game: "coup",
  rules: {
    name: "Coup",
    summary: "bluff",
    available_actions: {
      income: "1",
      foreign_aid: "2",
      coup: "7",
      tax: "3",
      assassinate: "kill",
      steal: "take",
      exchange: "swap",
      challenge: "doubt",
      pass: "skip",
      block: "deny",
      lose_card: "reveal",
      return_cards: "return",
    },
    key_rules: ["Mandatory coup at 10 coins."],
  },
};
const legal: LegalAction = { type: "income", data: {} };
const dpOpts: DirectModelProviderOptions = {
  name: "consumer-provider",
  apiKeyResolver: (provider, model) => `key:${provider}:${model}`,
};

function acceptProvider(p: DecisionProvider): string {
  return p.name;
}

const okParse: ParseResult = {
  kind: "ok",
  action: legal,
  summary: "income",
};
const badParse: ParseResult = {
  kind: "invalid",
  reason: "json_parse",
  rawSnippet: "garbage",
};
const reason: ParseInvalidReason = "data_validation";

const decisionReq: DecisionRequest = {
  game,
  matchId: "match-x",
  playerId: "p1",
  rules: rules.rules,
  legalActions: [legal],
  publicState: {},
  players: [],
  recentEvents: [],
  strategyProfile: stratProfile,
  turnTimeoutMs: 300_000,
  decisionBudgetMs: 30_000,
};
const decisionRes: DecisionResponse = {
  action: "income",
  providerMetadata: {
    provider: "anthropic",
    model: "claude-opus-4-7",
    latencyMs: 1,
    retries: 0,
    fallback: false,
  },
};
const meta: DecisionResponseProviderMetadata = decisionRes.providerMetadata;
const decisionProtocolVersion: string = DECISION_PROTOCOL_VERSION;
const decisionProtocolStrategy: DecisionProtocolStrategySection = {
  name: "general",
  format: "markdown",
  sha256: "a".repeat(64),
};
const decisionProtocolOpts: BuildDecisionProtocolRequestOptions = {
  requestId: "session-x:turn",
  strategy: [decisionProtocolStrategy],
};
const decisionProtocolReq: DecisionProtocolRequest = buildDecisionProtocolRequest({
  matchId: "session-x",
  game: "coup",
  state: {
    phase: "deciding",
    transport: "connected",
    agentId: "agent-x",
    agentName: "ConsumerTest",
    availableGames: ["coup"],
    autoConfirmMatches: true,
  },
  actionRequest: {
    type: "action_request",
    data: {
      match_id: "session-x",
      state: {},
      legal_actions: [legal],
      players: [],
      timeout_ms: 300_000,
      new_events: [],
      request_id: "ffffffff-0000-0000-0000-000000000001",
    },
  },
}, decisionProtocolOpts);
const decisionProtocolRes: DecisionProtocolResponse = {
  type: "aifight.decision.action",
  protocol_version: "aifight.decision.v1",
  request_id: decisionProtocolReq.request_id,
  action: legal,
};
const decisionProtocolAction: unknown = readDecisionProtocolAction(decisionProtocolRes);
const decisionProtocolErr = new DecisionProtocolResponseError("bad response");

// 5. ───────── Step 4b CONTRACT GUARD (the load-bearing assertion) ────
//    WSClient is `export type { WSClient }` from src/index.ts. Using
//    it as a runtime value MUST be a TypeScript error. If a future
//    change drops the `type` keyword (i.e. writes
//    `export { WSClient }`), the @ts-expect-error directive becomes
//    unused → tsc emits "Unused '@ts-expect-error' directive" → this
//    file fails to compile → build.sh aborts with a clear signal.
//
//    The error code TypeScript emits at the offending line is TS2693:
//    "'WSClient' only refers to a type, but is being used as a value
//    here." That's exactly the constraint Step 4b enforces.

// @ts-expect-error - WSClient is type-only; using it as a value is forbidden
const _typeOnlyGuard: unknown = WSClient;

// Symmetric guard for WSClientMessage strict union (B 路线): the
// strict union requires `match_id` on `action`. A missing
// `match_id` MUST be a compile error.

// @ts-expect-error - action requires match_id (rev 3 P2 #4 strict union)
const _badAction: WSClientMessage = { type: "action", data: {} };

// ─── Reference all bindings so isolatedModules / no-unused checks
// don't strip anything; same trick as the M1-01 / M1-04 / M1-05
// blocks already used. ─────────────────────────────────────────────────
void openDatabase;
void acceptStore;
void kind;
void accept;
void schema;
void types;
void version;
void ver;
void schemas;
void welcome;
void encryptForStorage;
void decryptFromStorage;
void deleteFromStorage;
void isKeychainAvailable;
void getCredentialsBackend;
void CredentialsError;
void CredentialsCorruptError;
void credBackend;
void credKind;
void cwc;
void acceptClient;
void msgLeave;
void msgJoin;
void msgConfirm;
void msgAction;
void closeInfo;
void onMsg;
void onErr;
void onClose;
void env;
void errKind;
void opts;
void welcomeFrame;
void WSClientError;
void WSConnectError;
void WSHandshakeError;
void WSWelcomeTimeoutError;
void WSWelcomeInvalidError;
void WSProtocolVersionError;
void WSClosedError;
void WSSchemaError;
void WSOutboundSchemaError;
void WSUnknownMessageError;
void WSAbortedError;
void crwc;
void reconnectOptions;
void reconnectEvent;
void onReconnect;
void reconnectClose;
void onReconnectClose;
void acceptReconnectClient;
void stopErr;
void ReconnectStoppedError;
void _typeOnlyGuard;
void _badAction;
void cdmp;
void dpe;
void dpeKind;
void dmpName;
void dmpName2;
void stratProfile;
void gsp;
void game;
void rules;
void legal;
void dpOpts;
void acceptProvider;
void okParse;
void badParse;
void reason;
void decisionReq;
void decisionRes;
void meta;
void decisionProtocolVersion;
void decisionProtocolStrategy;
void decisionProtocolOpts;
void decisionProtocolReq;
void decisionProtocolRes;
void decisionProtocolAction;
void decisionProtocolErr;
void buildDecisionProtocolRequest;
void readDecisionProtocolAction;
void DecisionProtocolResponseError;
void DecisionProviderError;
