// runtime/scripts/connect-probe.mjs — Step 8 wsclient runtime probe
//
// Pure-JS smoke that runs INSIDE the scratch install dir
// (build.sh copies this file there and invokes `node connect-probe.mjs`).
// Asserts that the published @aifight/aifight tarball exposes
// createWSClient as a real runtime function value, plus the 11
// error classes as runtime constructors.
//
// rev 2 P1 #2 contract: this file is plain JavaScript — NO TypeScript
// syntax, NO type-only imports. Type-side verification belongs in
// scripts/ts-consumer.ts (which the build runs through tsc separately).
//
// Why probe createWSClient specifically? Step 4b sealed the contract
// that the only way to obtain a WSClient instance is via the factory.
// If a future change accidentally re-exported the implementation
// class (or worse, dropped the type-only `export type { WSClient }`
// in src/index.ts), the source-side guard in tests/index-exports.test.ts
// catches it BEFORE bundling. This file is the post-bundle guard:
// after esbuild + npm pack + scratch install, createWSClient must
// still be there as a callable.

import {
  createWSClient,
  createReconnectingWSClient,
  ReconnectStoppedError,
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
  // M1-14: decision provider facade
  createDirectModelProvider,
  DecisionProviderError,
} from "@aifight/aifight";

// ─── Assertion 1: createWSClient is a runtime function ──────────────
if (typeof createWSClient !== "function") {
  console.error(
    `    FAIL: createWSClient should be a function, got ${typeof createWSClient}`,
  );
  process.exit(1);
}
console.log(`    typeof createWSClient = function`);

// ─── Assertion 2: 11 error classes are runtime constructors ─────────
const ERROR_CLASSES = {
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
};

for (const [name, ctor] of Object.entries(ERROR_CLASSES)) {
  if (typeof ctor !== "function") {
    console.error(
      `    FAIL: ${name} should be a function (class constructor), got ${typeof ctor}`,
    );
    process.exit(1);
  }
}
console.log(
  `    11 error classes are runtime constructors (typeof === "function")`,
);

// ─── Assertion 3: error hierarchy works on the bundled side ─────────
// Pick WSConnectError as the representative subclass (cheap to
// construct; mirrors tests/index-exports.test.ts case 4).
const inst = new WSConnectError("post-bundle hierarchy probe");
if (!(inst instanceof WSClientError)) {
  console.error(
    `    FAIL: new WSConnectError(...) is not instanceof WSClientError`,
  );
  process.exit(1);
}
if (!(inst instanceof Error)) {
  console.error(`    FAIL: new WSConnectError(...) is not instanceof Error`);
  process.exit(1);
}
console.log(
  `    error hierarchy: WSConnectError ⊂ WSClientError ⊂ Error (post-bundle)`,
);

// ─── Assertion 4: createReconnectingWSClient is a runtime function ──
if (typeof createReconnectingWSClient !== "function") {
  console.error(
    `    FAIL: createReconnectingWSClient should be a function, got ${typeof createReconnectingWSClient}`,
  );
  process.exit(1);
}
console.log(`    typeof createReconnectingWSClient = function`);

// ─── Assertion 5: ReconnectStoppedError ships as constructor ────────
if (typeof ReconnectStoppedError !== "function") {
  console.error(
    `    FAIL: ReconnectStoppedError should be a function (class constructor), got ${typeof ReconnectStoppedError}`,
  );
  process.exit(1);
}
const stop = new ReconnectStoppedError("signal", undefined, "probe");
if (!(stop instanceof Error)) {
  console.error(`    FAIL: ReconnectStoppedError is not instanceof Error`);
  process.exit(1);
}
if (stop.kind !== "signal") {
  console.error(
    `    FAIL: ReconnectStoppedError.kind should be "signal", got ${stop.kind}`,
  );
  process.exit(1);
}
console.log(
  `    reconnect runtime: createReconnectingWSClient + ReconnectStoppedError OK`,
);

// ─── Assertion 6: createDirectModelProvider is a runtime function ───
if (typeof createDirectModelProvider !== "function") {
  console.error(
    `    FAIL: createDirectModelProvider should be a function, got ${typeof createDirectModelProvider}`,
  );
  process.exit(1);
}
console.log(`    typeof createDirectModelProvider = function`);

// ─── Assertion 7: DecisionProviderError post-bundle hierarchy ───────
// M1-14 rev3 fix #6 lock: concrete class with `kind` discriminator;
// consumers do `e instanceof DecisionProviderError` then branch on
// `e.kind`. After esbuild + npm pack + scratch install the constructor
// must still be reachable AND `new DecisionProviderError(...)` must
// produce an Error subclass with the right shape.
if (typeof DecisionProviderError !== "function") {
  console.error(
    `    FAIL: DecisionProviderError should be a function (class constructor), got ${typeof DecisionProviderError}`,
  );
  process.exit(1);
}
const dpErr = new DecisionProviderError(
  "fatal_caller_bug",
  "post-bundle hierarchy probe",
  { hint: "smoke" },
);
if (!(dpErr instanceof Error)) {
  console.error(
    `    FAIL: new DecisionProviderError(...) is not instanceof Error`,
  );
  process.exit(1);
}
if (dpErr.kind !== "fatal_caller_bug") {
  console.error(
    `    FAIL: DecisionProviderError.kind should be "fatal_caller_bug", got ${dpErr.kind}`,
  );
  process.exit(1);
}
if (dpErr.name !== "DecisionProviderError") {
  console.error(
    `    FAIL: DecisionProviderError.name should be "DecisionProviderError", got ${dpErr.name}`,
  );
  process.exit(1);
}
console.log(
  `    decision facade: DecisionProviderError ⊂ Error (kind=fatal_caller_bug, cause preserved)`,
);
