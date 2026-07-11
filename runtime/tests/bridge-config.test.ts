import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Entry } from "@napi-rs/keyring";

import {
  dropClaimCredentialsAfterClaim,
  getBridgeConfigPath,
  normalizeRuntimeLocalUrl,
  readBridgeConfig,
  redactBridgeConfig,
  removeBridgeConfig,
  RuntimeLocalUrlError,
  validatePlatformBaseUrl,
  writeBridgeConfig,
  wsUrlIsValid,
  type BridgeConfig,
} from "../src/bridge/config";
import {
  AIFIGHT_CRYPTO_V1_PREFIX,
  AIFIGHT_KEYCHAIN_V1_PREFIX,
} from "../src/account/credentials";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): string {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-bridge-config-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
  return tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

function config(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "alpha",
    apiKey: "sk-test-secret-key",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: "2026-05-06T00:00:00.000Z",
  };
}

describe("bridge config", () => {
  it("writes and reads local bridge config under runtime home", () => {
    useTempHome();
    const cfg = config();

    writeBridgeConfig(cfg);

    expect(getBridgeConfigPath()).toMatch(/bridge\.json$/);
    expect(readBridgeConfig()).toEqual(cfg);
  });

  it("redacts platform secrets for status output", () => {
    const redacted = redactBridgeConfig(config());

    expect(redacted.apiKey).not.toContain("secret");
    expect(redacted.runtimeType).toBe("direct");
  });

  it("accepts the direct and mock sentinel runtime URLs", () => {
    expect(normalizeRuntimeLocalUrl("mock://local", "mock")).toBe("mock://local");
    expect(normalizeRuntimeLocalUrl("direct://local", "direct")).toBe("direct://local");
  });

  it("rejects runtime URLs that are neither loopback nor the sentinel", () => {
    expect(() => normalizeRuntimeLocalUrl("http://0.0.0.0:18789", "direct")).toThrow(RuntimeLocalUrlError);
    expect(() => normalizeRuntimeLocalUrl("https://example.com", "direct")).toThrow(RuntimeLocalUrlError);
    expect(() => normalizeRuntimeLocalUrl("http://127.0.0.1:18789/v1", "direct")).toThrow(RuntimeLocalUrlError);
  });

  it("rejects bridge config that points runtime traffic away from loopback", () => {
    useTempHome();
    const cfg = { ...config(), runtimeLocalUrl: "http://example.com:18789" };

    writeBridgeConfig(cfg);

    expect(() => readBridgeConfig()).toThrow("bridge config is invalid");
  });

  // R13 F-05: a hand-edited bridge.json whose base was downgraded to plaintext
  // http (public host) must be refused on read — the API key ships to that host.
  it("rejects a hand-edited plaintext-http base on read (R13 F-05)", () => {
    useTempHome();
    const cfg = {
      ...config(),
      baseUrl: "http://public.example",
      wsUrl: "wss://public.example/api/ws", // keeps isBridgeConfig happy so the base gate is what fires
    };

    writeBridgeConfig(cfg);

    expect(() => readBridgeConfig()).toThrow(/plain http/i);
  });
});

// F10/AIF-04: the platform API key and claim token are encrypted at rest —
// bridge.json holds only "enc:" references. The whole suite runs under
// AIFIGHT_FORCE_FALLBACK=1 (vitest config), so these exercise the AES file
// fallback; keychain-backend mechanics are covered by account-credentials.
describe("bridge config credential encryption (F10)", () => {
  function rawOnDisk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(getBridgeConfigPath(), "utf8")) as Record<string, unknown>;
  }

  it("stores apiKey and claimToken encrypted at rest, returns plaintext on read", () => {
    useTempHome();
    const cfg: BridgeConfig = {
      ...config(),
      claimUrl: "https://aifight.ai/claim/tok-plain-claim-secret",
      claimToken: "tok-plain-claim-secret",
    };

    writeBridgeConfig(cfg);

    const disk = rawOnDisk();
    expect(disk.apiKey).toMatch(/^enc:/);
    expect(disk.claimToken).toMatch(/^enc:/);
    // claimUrl embeds the claim token in its path, so it is encrypted too.
    expect(disk.claimUrl).toMatch(/^enc:/);
    const rawText = fs.readFileSync(getBridgeConfigPath(), "utf8");
    expect(rawText).not.toContain("sk-test-secret-key");
    expect(rawText).not.toContain("tok-plain-claim-secret");

    expect(readBridgeConfig()).toEqual(cfg);
  });

  it("migrates a legacy plaintext bridge.json to encrypted form on first read", () => {
    const dir = useTempHome();
    const cfg: BridgeConfig = { ...config(), claimToken: "tok-legacy-claim" };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getBridgeConfigPath(), JSON.stringify(cfg, null, 2) + "\n");

    expect(readBridgeConfig()).toEqual(cfg); // plaintext still readable

    const disk = rawOnDisk();
    expect(disk.apiKey).toMatch(/^enc:/); // ...and rewritten encrypted
    expect(disk.claimToken).toMatch(/^enc:/);
    expect(readBridgeConfig()).toEqual(cfg); // round-trips after migration
  });

  it("maps an undecryptable credential to a re-link error", () => {
    const dir = useTempHome();
    const corrupt =
      "enc:" + Buffer.from(AIFIGHT_CRYPTO_V1_PREFIX + "too-short").toString("base64");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      getBridgeConfigPath(),
      JSON.stringify({ ...config(), apiKey: corrupt }, null, 2) + "\n",
    );

    expect(() => readBridgeConfig()).toThrow(/unreadable on this machine/);
  });

  it("dropClaimCredentialsAfterClaim scrubs claim artifacts and keeps the rest", () => {
    useTempHome();
    writeBridgeConfig({
      ...config(),
      claimUrl: "https://aifight.ai/claim/tok-claim-once",
      claimToken: "tok-claim-once",
    });

    dropClaimCredentialsAfterClaim();

    const after = readBridgeConfig();
    expect(after.claimToken).toBeUndefined();
    expect(after.claimUrl).toBeUndefined();
    expect(after.apiKey).toBe("sk-test-secret-key");
    expect(rawOnDisk()).not.toHaveProperty("claimToken");

    // Idempotent: a second observation is a no-op, not an error.
    dropClaimCredentialsAfterClaim();
    expect(readBridgeConfig().claimToken).toBeUndefined();
  });

  it("removeBridgeConfig deletes the file (and is safe when absent)", () => {
    useTempHome();
    writeBridgeConfig(config());
    removeBridgeConfig();
    expect(fs.existsSync(getBridgeConfigPath())).toBe(false);
    removeBridgeConfig(); // no file → no throw
  });
});

// D1: a bridge.json whose credential fields still point at OS-keychain entries
// migrates to the AES file backend on read, so future reads never touch the
// keychain (no macOS authorization popup). Keychain decrypt/delete is
// format-driven and works even under the suite-wide AIFIGHT_FORCE_FALLBACK=1.
describe("bridge config keychain → file migration (D1)", () => {
  const keychainAvailable: boolean = (() => {
    const svc = "aifight-envprobe-" + randomUUID();
    try {
      const e = new Entry(svc, "check-" + randomUUID());
      e.setPassword("probe");
      try {
        e.deletePassword();
      } catch {
        // best effort
      }
      return true;
    } catch {
      return false;
    }
  })();

  let service = "";
  let uuidToClean = "";

  afterEach(() => {
    if (service && uuidToClean) {
      try {
        new Entry(service, uuidToClean).deletePassword();
      } catch {
        // best effort
      }
    }
    delete process.env.AIFIGHT_KEYCHAIN_SERVICE;
    service = "";
    uuidToClean = "";
  });

  it.skipIf(!keychainAvailable)(
    "rewrites a legacy keychain-format field to a file BLOB on read and releases the entry",
    () => {
      const dir = useTempHome();
      service = "aifight-test-" + randomUUID();
      process.env.AIFIGHT_KEYCHAIN_SERVICE = service; // isolate from production

      // Build a legacy keychain-format apiKey ref exactly as pre-D1 encrypt did.
      const uuid = randomUUID();
      uuidToClean = uuid;
      new Entry(service, uuid).setPassword("sk-test-secret-key");
      const keychainBlob = Buffer.concat([
        Buffer.from(AIFIGHT_KEYCHAIN_V1_PREFIX, "ascii"),
        Buffer.from(uuid, "ascii"),
      ]);
      const encField = "enc:" + keychainBlob.toString("base64");

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        getBridgeConfigPath(),
        JSON.stringify({ ...config(), apiKey: encField }, null, 2) + "\n",
      );

      // Read decrypts via the keychain, returns plaintext, and migrates the file.
      expect(readBridgeConfig().apiKey).toBe("sk-test-secret-key");

      // On disk the apiKey is now a file BLOB (AIFIGHT_CRYPTO_V1), not a keychain ref.
      const disk = JSON.parse(fs.readFileSync(getBridgeConfigPath(), "utf8")) as Record<string, unknown>;
      const migrated = Buffer.from((disk.apiKey as string).slice("enc:".length), "base64");
      expect(migrated.subarray(0, 18).toString("ascii")).toBe(AIFIGHT_CRYPTO_V1_PREFIX);
      expect(migrated.subarray(0, 20).toString("ascii")).not.toBe(AIFIGHT_KEYCHAIN_V1_PREFIX);

      // The now-orphaned keychain entry was released, and a second read is a
      // clean no-migration round-trip.
      expect(new Entry(service, uuid).getPassword()).toBeNull();
      expect(readBridgeConfig().apiKey).toBe("sk-test-secret-key");
    },
  );
});

describe("wsUrlIsValid", () => {
  it("accepts a same-host wss:// url against an https base", () => {
    expect(wsUrlIsValid("wss://aifight.ai/api/ws", "https://aifight.ai")).toBe(true);
  });

  it("rejects plaintext downgrade against an https base", () => {
    expect(wsUrlIsValid("ws://aifight.ai/api/ws", "https://aifight.ai")).toBe(false);
  });

  it("rejects a different host (would leak the agent key)", () => {
    expect(wsUrlIsValid("wss://evil.example/api/ws", "https://aifight.ai")).toBe(false);
  });

  it("rejects embedded credentials", () => {
    expect(wsUrlIsValid("wss://user:pass@aifight.ai/api/ws", "https://aifight.ai")).toBe(false);
  });

  it("allows ws:// only for an http (dev/loopback) base on the same host", () => {
    expect(wsUrlIsValid("ws://localhost:8080/api/ws", "http://localhost:8080")).toBe(true);
    expect(wsUrlIsValid("wss://localhost:8080/api/ws", "http://localhost:8080")).toBe(true);
    expect(wsUrlIsValid("ws://other.local/api/ws", "http://localhost:8080")).toBe(false);
  });

  // R13 F-05: a plaintext (non-loopback) http base previously accepted ws:// to
  // that public host, leaking the upgrade-header key. Now only wss:// is allowed.
  it("rejects ws:// for a non-loopback (public) http base (R13 F-05)", () => {
    expect(wsUrlIsValid("ws://public.example/api/ws", "http://public.example")).toBe(false);
    expect(wsUrlIsValid("wss://public.example/api/ws", "http://public.example")).toBe(true);
  });

  it("rejects unparseable urls", () => {
    expect(wsUrlIsValid("not a url", "https://aifight.ai")).toBe(false);
  });
});

// R13 F-05: the platform API key / pairing code is sent to the base URL, so it
// must be https (or loopback http only under an explicit dev escape hatch).
describe("validatePlatformBaseUrl (R13 F-05)", () => {
  afterEach(() => {
    delete process.env.AIFIGHT_ALLOW_INSECURE_BASE_URL;
  });

  it("accepts https and normalizes trailing slash / strips query+fragment", () => {
    expect(validatePlatformBaseUrl("https://aifight.ai/")).toBe("https://aifight.ai");
    expect(validatePlatformBaseUrl("https://beta.aifight.ai")).toBe("https://beta.aifight.ai");
    expect(validatePlatformBaseUrl("https://aifight.ai/base/?x=1#f")).toBe("https://aifight.ai/base");
  });

  it("rejects plain http to a public host (with or without the dev env)", () => {
    expect(() => validatePlatformBaseUrl("http://aifight.ai")).toThrow(/plain http/i);
    process.env.AIFIGHT_ALLOW_INSECURE_BASE_URL = "1";
    expect(() => validatePlatformBaseUrl("http://public.example")).toThrow(/plain http/i);
  });

  it("rejects http to loopback WITHOUT the dev env var", () => {
    expect(() => validatePlatformBaseUrl("http://127.0.0.1:8080")).toThrow(/plain http/i);
  });

  it("accepts http to loopback WITH the dev env var", () => {
    process.env.AIFIGHT_ALLOW_INSECURE_BASE_URL = "1";
    expect(validatePlatformBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(validatePlatformBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("rejects embedded userinfo even over https", () => {
    expect(() => validatePlatformBaseUrl("https://user:pass@aifight.ai")).toThrow(/credentials/i);
  });

  it("rejects non-http(s) schemes and garbage", () => {
    expect(() => validatePlatformBaseUrl("ftp://aifight.ai")).toThrow(/https/i);
    expect(() => validatePlatformBaseUrl("not a url")).toThrow(/valid URL/i);
  });
});
