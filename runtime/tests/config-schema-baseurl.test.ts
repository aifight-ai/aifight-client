import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, validateConfig } from "../src/profile/config-schema.js";

// F40/R2-09: the provider key is sent to baseURL, so the schema must reject
// plaintext-HTTP remote hosts and URL-embedded credentials, while keeping
// https and local self-hosted (loopback/private http) workflows working.

function configWithBaseURL(baseURL: string): unknown {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as {
    profiles: Record<string, { baseURL?: string }>;
  };
  cfg.profiles["claude-default"].baseURL = baseURL;
  return cfg;
}

describe("profile baseURL safety (F40)", () => {
  afterEach(() => {
    delete process.env.AIFIGHT_ALLOW_INSECURE_PROVIDER_URL;
  });

  it("accepts https to any host", () => {
    expect(validateConfig(configWithBaseURL("https://api.example.com/v1")).ok).toBe(true);
  });

  it.each([
    "http://localhost:11434",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:4000",
    "http://192.168.1.20:8000",
    "http://10.0.0.5:8000",
    "http://172.16.0.2:9000",
  ])("accepts http to loopback/private self-hosted (%s)", (u) => {
    expect(validateConfig(configWithBaseURL(u)).ok).toBe(true);
  });

  it("rejects plain http to a remote host", () => {
    const res = validateConfig(configWithBaseURL("http://llm.example.com/v1"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.join("\n")).toContain("unencrypted");
    }
  });

  it("allows remote http only with the explicit escape hatch", () => {
    process.env.AIFIGHT_ALLOW_INSECURE_PROVIDER_URL = "1";
    expect(validateConfig(configWithBaseURL("http://llm.example.com/v1")).ok).toBe(true);
  });

  it("rejects URL-embedded credentials even over https", () => {
    const res = validateConfig(configWithBaseURL("https://user:secret@api.example.com"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.join("\n")).toContain("credentials");
    }
  });

  it("rejects non-http(s) schemes and garbage", () => {
    expect(validateConfig(configWithBaseURL("file:///etc/passwd")).ok).toBe(false);
    expect(validateConfig(configWithBaseURL("not a url")).ok).toBe(false);
  });
});

// F23/AIF-08: keychain/command SecretRef backends are typed but not
// implemented — the schema must reject them at load time with a clear
// message, not let the bridge boot and throw mid-match.
describe("unimplemented SecretRef backends fail at load (F23)", () => {
  function configWithApiKeyRef(apiKeyRef: unknown): unknown {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as {
      profiles: Record<string, { apiKeyRef?: unknown }>;
    };
    cfg.profiles["claude-default"].apiKeyRef = apiKeyRef;
    return cfg;
  }

  it("rejects keychain refs with an actionable message", () => {
    const res = validateConfig(
      configWithApiKeyRef({ type: "keychain", service: "aifight", account: "me" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toContain("not implemented yet");
  });

  it("rejects command refs with an actionable message", () => {
    const res = validateConfig(configWithApiKeyRef({ type: "command", command: "op read x" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toContain("not implemented yet");
  });

  it("still accepts the implemented backends", () => {
    expect(validateConfig(configWithApiKeyRef({ type: "env", name: "X_KEY" })).ok).toBe(true);
  });
});
