// runtime/tests/index-exports.test.ts
//
// Step 6 sanity tests for the @aifight/aifight public entry point's
// wsclient surface. Catches accidental regressions in two
// load-bearing contracts:
//
//   (1) WSClient is TYPE-ONLY. Step 4b locked the contract that the
//       only way to obtain a WSClient instance is via
//       createWSClient() — exposing the class value at runtime
//       would let callers fabricate "authenticated" clients
//       without the welcome handshake. If a future change wrote
//       `export { WSClient }` instead of `export type { WSClient }`,
//       case 2 trips immediately.
//
//   (2) All 11 error classes ship as runtime constructors so callers
//       can do `e instanceof WSConnectError` without first importing
//       a separate path. The abstract base WSClientError is also
//       exported (TypeScript prevents `new` at compile time, but
//       the class value is still useful for super-class instanceof).
//
// Why import("../src/index") and not the bundled dist? vitest runs
// against source per the M1-04 / M1-05 / M1-06 testing pattern; the
// build.sh smoke (Step 7-8) covers the bundled package shape via
// connect-probe.mjs and ts-consumer.ts. This file is the source-side
// guard.

import { describe, expect, it } from "vitest";

const ERROR_CLASS_NAMES = [
  "WSClientError",
  "WSConnectError",
  "WSHandshakeError",
  "WSWelcomeTimeoutError",
  "WSWelcomeInvalidError",
  "WSProtocolVersionError",
  "WSClosedError",
  "WSSchemaError",
  "WSOutboundSchemaError",
  "WSUnknownMessageError",
  "WSAbortedError",
] as const;

const TYPE_ONLY_NAMES = [
  "WSClient",
  "WSClientMessage",
  "WSClientOptions",
  "WSWelcome",
  "ServerMessageEnvelope",
  "WSCloseInfo",
  "WSMessageHandler",
  "WSErrorHandler",
  "WSCloseHandler",
  "WSClientErrorKind",
  "ReconnectingWSClient",
  "ReconnectingWSClientOptions",
  "ReconnectEvent",
  "ReconnectEventHandler",
  "ReconnectCloseInfo",
  "ReconnectCloseHandler",
  "ReconnectStopReason",
  "JitterStrategy",
  // M1-14: decision provider facade type-only exports
  "DecisionProvider",
  "DirectModelProviderOptions",
  "DirectModelProviderName",
  "DecisionProviderErrorKind",
  "DecisionRequest",
  "DecisionResponse",
  "DecisionResponseProviderMetadata",
  "StrategyProfile",
  "GameSpecificProfile",
  "GameType",
  "GameRules",
  "LegalAction",
  "BuildDecisionProtocolRequestOptions",
  "DecisionProtocolRequest",
  "DecisionProtocolResponse",
  "DecisionProtocolStrategySection",
  "ParseResult",
  "ParseInvalidReason",
] as const;

// M1-14 rev3 fix #6 lock 选 B: M1-11 DirectModelError 5 classes are
// wrapped as DecisionProviderError; raw instances surface only via
// `error.cause`. They MUST NOT be runtime exports of @aifight/aifight.
// Same lock for M1-11 / M1-12 / M1-13 / M1-14 internal building blocks
// — consumers reach them through createDirectModelProvider.
const DECISION_INTERNAL_NAMES = [
  // M1-11 DirectModelError 5 classes — concrete + abstract
  "DirectModelError",
  "DirectModelHttpError",
  "DirectModelNetworkError",
  "DirectModelAbortedError",
  "DirectModelInvalidResponseError",
  "DirectModelUnsupportedError",
  // M1-11 direct-model factories
  "createAnthropicClient",
  "createOpenAIClient",
  // M1-12 prompt-builder + state-formatter
  "buildPrompt",
  "formatTexasHoldemState",
  "formatLiarsDiceState",
  "formatCoupState",
  // M1-13 per-game fallback
  "fallbackTexasHoldem",
  "fallbackLiarsDice",
  "fallbackCoup",
  // M1-14 per-game LLM action parser
  "parseTexasHoldemAction",
  "parseLiarsDiceAction",
  "parseCoupAction",
] as const;

describe("@aifight/aifight — wsclient public surface (Step 6)", () => {
  it("case 1: createWSClient is exported as a runtime function", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    expect(typeof mod.createWSClient).toBe("function");
  });

  it("case 2: WSClient is type-only — must NOT be a runtime class value", async () => {
    // Step 4b contract: the only way to obtain a WSClient instance
    // is via createWSClient() factory. If a future change wrote
    // `export { WSClient }` instead of `export type { WSClient }`,
    // this assertion catches it before the regression ships.
    const mod = (await import("../src/index")) as Record<string, unknown>;
    expect("WSClient" in mod).toBe(false);
  });

  it("case 3: all 11 wsclient error classes are exported as runtime constructors", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    for (const name of ERROR_CLASS_NAMES) {
      expect(typeof mod[name], `expected ${name} to be a function`).toBe(
        "function",
      );
    }
  });

  it("case 4: error class hierarchy — concrete classes extend WSClientError and Error", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    const ClientErrorCtor = mod.WSClientError as new (
      ...args: unknown[]
    ) => unknown;
    // WSConnectError(message, cause?) is the cheapest concrete to
    // construct (just a string). Pick it as a representative case.
    const ConnectErrorCtor = mod.WSConnectError as new (
      msg: string,
      cause?: unknown,
    ) => unknown;
    const inst = new ConnectErrorCtor("sanity check");
    expect(inst).toBeInstanceOf(ClientErrorCtor);
    expect(inst).toBeInstanceOf(Error);
  });

  it("case 5: type-only exports are absent from the runtime module record", async () => {
    // TypeScript type-only exports (`export type { X }`) are erased
    // at compile time and must NOT appear as properties on the
    // module record. If a future change accidentally drops the
    // `type` keyword on any of these, this case catches it.
    const mod = (await import("../src/index")) as Record<string, unknown>;
    for (const name of TYPE_ONLY_NAMES) {
      expect(
        name in mod,
        `expected ${name} to be type-only (absent at runtime)`,
      ).toBe(false);
    }
  });

  it("case 6: createReconnectingWSClient is exported as a runtime function", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    expect(typeof mod.createReconnectingWSClient).toBe("function");
  });

  it("case 7: ReconnectStoppedError is exported as a runtime constructor", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    const Ctor = mod.ReconnectStoppedError as new (
      kind: string,
      cause: unknown,
      message: string,
    ) => Error & { kind?: string };
    expect(typeof Ctor).toBe("function");
    const inst = new Ctor("signal", undefined, "probe");
    expect(inst).toBeInstanceOf(Error);
    expect(inst.kind).toBe("signal");
  });

  // M1-14 Step 3 decision provider surface guards.

  it("case 8: createDirectModelProvider is exported as a runtime function", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    expect(typeof mod.createDirectModelProvider).toBe("function");
  });

  it("case 9: DecisionProviderError ships as runtime class with kind discriminator + Error hierarchy", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    const Ctor = mod.DecisionProviderError as new (
      kind: string,
      message: string,
      cause?: unknown,
    ) => Error & { kind?: string; cause?: unknown };
    expect(typeof Ctor).toBe("function");
    const inst = new Ctor("fatal_caller_bug", "probe", { hint: 1 });
    expect(inst).toBeInstanceOf(Error);
    expect(inst.kind).toBe("fatal_caller_bug");
    expect(inst.cause).toEqual({ hint: 1 });
    expect(inst.name).toBe("DecisionProviderError");
  });

  it("case 10: M1-11/M1-12/M1-13/M1-14 internal building blocks are NOT runtime exports", async () => {
    // M1-14 rev3 lock: facade-only public surface. Wrapping
    // DirectModelError into DecisionProviderError + keeping per-game
    // parsers / formatters / fallbacks / direct-model factories
    // internal forces the consumer through createDirectModelProvider.
    const mod = (await import("../src/index")) as Record<string, unknown>;
    for (const name of DECISION_INTERNAL_NAMES) {
      expect(
        name in mod,
        `expected ${name} to be internal (absent from @aifight/aifight root)`,
      ).toBe(false);
    }
  });

  it("case 11: Decision Protocol v1 facade is exported", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    expect(mod.DECISION_PROTOCOL_VERSION).toBe("aifight.decision.v1");
    expect(typeof mod.buildDecisionProtocolRequest).toBe("function");
    expect(typeof mod.readDecisionProtocolAction).toBe("function");
    expect(typeof mod.DecisionProtocolResponseError).toBe("function");
  });
});
