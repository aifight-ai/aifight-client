// M1-16 Step 2 + Step 3 + Step 4 tests — Test Matrix Groups 1-9.
//
// Step 2: Group 1 lifecycle / Group 2 auth / Group 3 health + path +
//   method + Tier B 501 shape (cases 1-16).
// Step 3: Group 4 agents read / Group 5 join+leave / Group 6 schedule
//   (incl. rev3 fix #1 empty body 400, rev3 fix #2 missing scheduler
//   404, rev2 fix #3 invalid_state -> 503, rev2 fix #4 lookup cache
//   fallback) / Group 7 body limits (incl. rev3 fix #4 client
//   receives full HTTP 413, rev3 fix #1 empty body on /join).
// Step 3b: Group 6 case 41b GET /schedule sanitizes lastAttempt.cause.
// Step 4: Group 8 POST /v1/shutdown + onShutdown safety (incl. rev4
//   fix sync-throw + async-reject both caught, NO unhandledRejection
//   / NO uncaughtException) / Group 9 generic handler safety + 500
//   vs 404 disambiguation when scheduler.snapshot throws.
//
// All cases hit a real http.Server via fetch — no supertest dep.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";

import type { AgentInstanceSnapshot } from "../src/agents/agent";
import type { AgentFSMState } from "../src/agents/state-machine";
import { DailySchedulerError } from "../src/scheduler/daily";
import type { DailyScheduler } from "../src/scheduler/daily";
import type {
  DailyScheduleConfig,
  DailySchedulerSnapshot,
} from "../src/scheduler/types";

import { createControlServer } from "../src/controlapi/server";
import {
  ControlServerError,
  type ControlAgentHandle,
  type ControlLogEvent,
  type ControlRouterTarget,
  type ControlServer,
  type ControlServerOptions,
} from "../src/controlapi/types";

// Local stand-ins for the two router error shapes this test feeds into
// the control server. The server maps router throws to HTTP purely by
// duck-typing the `kind` discriminator (see controlapi/server.ts
// isRouterAgentNotFound) and never imports the concrete classes — so
// these minimal stubs exercise the exact runtime contract without
// depending on the removed daemon-mode router (Q1 dead-code removal).
class RouterAgentNotFoundError extends Error {
  readonly kind = "router_agent_not_found" as const;
  constructor(readonly selector: { name?: string; id?: string }) {
    super(`agent not found for selector ${JSON.stringify(selector)}`);
    this.name = "RouterAgentNotFoundError";
  }
}
class RouterAgentLifecycleError extends Error {
  readonly kind = "router_agent_lifecycle" as const;
  constructor(
    agentName: string,
    operation: "start" | "stop" | "remove",
    cause: unknown,
  ) {
    super(
      `agent '${agentName}' failed during ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "RouterAgentLifecycleError";
  }
}

// ─── Fixture builders ────────────────────────────────────────────────────

function makeFakeAgentState(
  overrides: Partial<AgentFSMState> = {},
): AgentFSMState {
  return {
    phase: "connected",
    transport: "connected",
    agentId: "id-default",
    agentName: "default",
    availableGames: ["texas_holdem"],
    autoConfirmMatches: false,
    ...overrides,
  };
}

function makeFakeAgentSnapshot(
  name: string,
  overrides: Partial<AgentInstanceSnapshot> = {},
): AgentInstanceSnapshot {
  return {
    name,
    started: true,
    stopped: false,
    transport: "connected",
    state: makeFakeAgentState({ agentId: `id-${name}`, agentName: name }),
    ...overrides,
  };
}

interface FakeRouterCalls {
  joinQueue: Array<{
    name: string;
    game: string;
    mode: string | undefined;
    opts: { readonly oneShot?: boolean; readonly count?: number } | undefined;
  }>;
  leaveQueue: Array<{ name: string }>;
  getAgent: Array<{ name: string }>;
  listAgents: number;
}

interface FakeRouterOptions {
  readonly snapshots?: ReadonlyMap<string, AgentInstanceSnapshot>;
  readonly getAgentImpl?: (name: string) => ControlAgentHandle;
  readonly joinQueueImpl?: (
    name: string,
    game: string,
    mode: string | undefined,
    opts: { readonly oneShot?: boolean; readonly count?: number } | undefined,
  ) => void;
  readonly leaveQueueImpl?: (name: string) => void;
  readonly listAgentsImpl?: () => readonly AgentInstanceSnapshot[];
}

function makeFakeRouter(opts: FakeRouterOptions = {}): {
  router: ControlRouterTarget;
  calls: FakeRouterCalls;
} {
  const calls: FakeRouterCalls = {
    joinQueue: [],
    leaveQueue: [],
    getAgent: [],
    listAgents: 0,
  };
  const snapshots = opts.snapshots ?? new Map<string, AgentInstanceSnapshot>();
  return {
    calls,
    router: {
      listAgents: () => {
        calls.listAgents += 1;
        if (opts.listAgentsImpl) return opts.listAgentsImpl();
        return [...snapshots.values()];
      },
      getAgent: (selector) => {
        calls.getAgent.push({ name: selector.name });
        if (opts.getAgentImpl) return opts.getAgentImpl(selector.name);
        const snap = snapshots.get(selector.name);
        if (!snap) {
          throw new RouterAgentNotFoundError({ name: selector.name });
        }
        return { snapshot: () => snap };
      },
      joinQueue: (selector, game, mode, joinOpts) => {
        calls.joinQueue.push({ name: selector.name, game, mode, opts: joinOpts });
        if (opts.joinQueueImpl) {
          return opts.joinQueueImpl(selector.name, game, mode, joinOpts);
        }
        if (!snapshots.has(selector.name)) {
          throw new RouterAgentNotFoundError({ name: selector.name });
        }
      },
      leaveQueue: (selector) => {
        calls.leaveQueue.push({ name: selector.name });
        if (opts.leaveQueueImpl) {
          return opts.leaveQueueImpl(selector.name);
        }
        if (!snapshots.has(selector.name)) {
          throw new RouterAgentNotFoundError({ name: selector.name });
        }
      },
    },
  };
}

function makeFakeSchedulerSnapshot(
  overrides: Partial<DailySchedulerSnapshot> = {},
): DailySchedulerSnapshot {
  return {
    running: true,
    today: "2026-04-27",
    remaining: { texas_holdem: 3 },
    lastAttempt: null,
    nextFireInMs: 60_000,
    ...overrides,
  };
}

interface FakeSchedulerCalls {
  setSchedule: Array<DailyScheduleConfig | null>;
  start: number;
  stop: number;
  snapshot: number;
}

interface FakeSchedulerOptions {
  readonly setScheduleImpl?: (cfg: DailyScheduleConfig | null) => void;
  readonly snapshot?: DailySchedulerSnapshot;
}

function makeFakeScheduler(opts: FakeSchedulerOptions = {}): {
  scheduler: DailyScheduler;
  calls: FakeSchedulerCalls;
} {
  const calls: FakeSchedulerCalls = {
    setSchedule: [],
    start: 0,
    stop: 0,
    snapshot: 0,
  };
  return {
    calls,
    scheduler: {
      start: () => {
        calls.start += 1;
      },
      stop: () => {
        calls.stop += 1;
      },
      snapshot: () => {
        calls.snapshot += 1;
        return opts.snapshot ?? makeFakeSchedulerSnapshot();
      },
      setSchedule: (cfg) => {
        calls.setSchedule.push(cfg);
        if (opts.setScheduleImpl) opts.setScheduleImpl(cfg);
      },
    },
  };
}

function makeValidScheduleConfig(
  overrides: Partial<DailyScheduleConfig> = {},
): DailyScheduleConfig {
  return {
    enabled: true,
    timezone: "UTC",
    days: { texas_holdem: { count: 3 } },
    ...overrides,
  };
}

// ─── Test harness ────────────────────────────────────────────────────────

function makeBareStubRouter(): ControlRouterTarget {
  // Default Step 1/2 router: throws unconditionally so any accidental
  // test exercising router methods fails loudly. Step 3 tests use
  // makeFakeRouter to supply a real surface.
  return {
    listAgents: () => [],
    getAgent: () => {
      throw new Error("router.getAgent not stubbed for this test");
    },
    joinQueue: () => {
      throw new Error("router.joinQueue not stubbed for this test");
    },
    leaveQueue: () => {
      throw new Error("router.leaveQueue not stubbed for this test");
    },
  };
}

interface HarnessOptions {
  readonly tokenSource?: () => string | null;
  readonly onLog?: (event: ControlLogEvent) => void;
  readonly host?: string;
  readonly port?: number;
  readonly router?: ControlRouterTarget;
  readonly schedulerLookup?: (agentName: string) => DailyScheduler | null;
  readonly scheduleConfigLookup?: (
    agentName: string,
  ) => DailyScheduleConfig | null;
  readonly bodyLimitBytes?: number;
  readonly onShutdown?: () => Promise<void> | void;
}

function makeOpts(overrides: HarnessOptions = {}): ControlServerOptions {
  return {
    tokenSource: overrides.tokenSource ?? (() => "test-token"),
    router: overrides.router ?? makeBareStubRouter(),
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 0,
    onLog: overrides.onLog,
    schedulerLookup: overrides.schedulerLookup,
    scheduleConfigLookup: overrides.scheduleConfigLookup,
    bodyLimitBytes: overrides.bodyLimitBytes,
    onShutdown: overrides.onShutdown,
  };
}

const activeServers = new Set<ControlServer>();

async function startServer(
  overrides: HarnessOptions = {},
): Promise<{ server: ControlServer; port: number; logs: ControlLogEvent[] }> {
  const logs: ControlLogEvent[] = [];
  const captured = (event: ControlLogEvent) => {
    logs.push(event);
    overrides.onLog?.(event);
  };
  const server = createControlServer(makeOpts({ ...overrides, onLog: captured }));
  activeServers.add(server);
  const port = await server.listen();
  return { server, port, logs };
}

afterEach(async () => {
  await Promise.all(
    [...activeServers].map(async (s) => {
      try {
        await s.close();
      } finally {
        activeServers.delete(s);
      }
    }),
  );
});

function authHeaders(token = "test-token"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

// Helper to find an OS-assigned free port without holding it open.
// We bind a throwaway net server on 0, capture the port, then close.
// There is a tiny race where another process could grab it before
// our test binds, but on a single-machine localhost test run this
// is overwhelmingly unlikely.
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (typeof addr === "string" || addr === null) {
        probe.close();
        reject(new Error("unexpected probe address shape"));
        return;
      }
      const p = addr.port;
      probe.close(() => resolve(p));
    });
  });
}

// ─── Group 1 — server lifecycle (5 cases) ────────────────────────────────

describe("M1-16 controlapi-server / Group 1 lifecycle", () => {
  it("case 1: listen() resolves with bound port > 0 and address() returns it", async () => {
    const { server, port } = await startServer();
    expect(port).toBeGreaterThan(0);
    expect(server.address()).toEqual({ host: "127.0.0.1", port });
  });

  it("case 2: listen() called twice rejects with ControlServerError invalid_state", async () => {
    const { server } = await startServer();
    await expect(server.listen()).rejects.toBeInstanceOf(ControlServerError);
    await expect(server.listen()).rejects.toMatchObject({
      kind: "invalid_state",
    });
  });

  it("case 3: listen() after close() rejects with ControlServerError invalid_state", async () => {
    const { server } = await startServer();
    await server.close();
    await expect(server.listen()).rejects.toMatchObject({
      kind: "invalid_state",
    });
  });

  it("case 4: close() is idempotent pre-listen and post-close", async () => {
    // Pre-listen close: create + immediately close, no throw.
    const preServer = createControlServer(makeOpts());
    activeServers.add(preServer);
    await expect(preServer.close()).resolves.toBeUndefined();
    // address() should remain null (never listened).
    expect(preServer.address()).toBeNull();

    // Post-close repeat: listen, close, close again — second close
    // resolves silently rather than throwing.
    const { server } = await startServer();
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    // address() returns null after close().
    expect(server.address()).toBeNull();
  });

  it("case 5: port 0 yields OS-assigned port; explicit port binds that exact port", async () => {
    // Half a: port 0 → OS-assigned > 0
    const { server: a, port: portA } = await startServer({ port: 0 });
    expect(portA).toBeGreaterThan(0);
    await a.close();
    activeServers.delete(a);

    // Half b: explicit fixed port → binds exactly that port
    const fixed = await pickFreePort();
    const { server: b, port: portB } = await startServer({ port: fixed });
    expect(portB).toBe(fixed);
    await b.close();
    activeServers.delete(b);
  });
});

// ─── Group 2 — auth (6 cases) ────────────────────────────────────────────

describe("M1-16 controlapi-server / Group 2 auth", () => {
  it("case 6: missing Authorization header → 401 unauthorized + auth_failed(missing_header)", async () => {
    const { port, logs } = await startServer();
    const { status, body } = await fetchJson(port, "/v1/health");
    expect(status).toBe(401);
    expect(body).toMatchObject({
      error: { code: "unauthorized" },
    });
    const authFailed = logs.filter((e) => e.code === "auth_failed");
    expect(authFailed).toHaveLength(1);
    expect(authFailed[0]?.reason).toBe("missing_header");
    expect(authFailed[0]?.level).toBe("warn");
  });

  it("case 7: Authorization not Bearer → 401 invalid_format", async () => {
    const { port, logs } = await startServer();
    const { status, body } = await fetchJson(port, "/v1/health", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: "unauthorized" } });
    expect(logs.some((e) => e.code === "auth_failed" && e.reason === "invalid_format")).toBe(true);
  });

  it("case 8: Bearer with wrong token (same length) → 401 token_mismatch", async () => {
    const { port, logs } = await startServer({
      tokenSource: () => "1234567890",
    });
    const { status, body } = await fetchJson(port, "/v1/health", {
      headers: { Authorization: "Bearer 0987654321" },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: "unauthorized" } });
    expect(logs.some((e) => e.code === "auth_failed" && e.reason === "token_mismatch")).toBe(true);
  });

  it("case 9: tokenSource returns null → 401 token_unset", async () => {
    const { port, logs } = await startServer({ tokenSource: () => null });
    const { status, body } = await fetchJson(port, "/v1/health", {
      headers: authHeaders("anything"),
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: "unauthorized" } });
    expect(logs.some((e) => e.code === "auth_failed" && e.reason === "token_unset")).toBe(true);
  });

  it("case 10: correct Bearer token → 200 on /v1/health", async () => {
    const { port } = await startServer({
      tokenSource: () => "valid-token-xyz",
    });
    const { status, body } = await fetchJson(port, "/v1/health", {
      headers: authHeaders("valid-token-xyz"),
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
  });

  it("case 11: timing-safe — different-length Bearer token short-circuits to 401 without crashing", async () => {
    // expected length = 10, supplied length = 3 — crypto.timingSafeEqual
    // would throw RangeError on unequal lengths; the length pre-check
    // converts that to a token_mismatch 401 instead. Issuing two
    // requests verifies the server stays alive past the mismatch.
    const { port, logs } = await startServer({
      tokenSource: () => "1234567890",
    });
    const first = await fetchJson(port, "/v1/health", {
      headers: { Authorization: "Bearer abc" },
    });
    expect(first.status).toBe(401);
    expect(logs.some((e) => e.code === "auth_failed" && e.reason === "token_mismatch")).toBe(true);
    // Server still serving — second authenticated request succeeds.
    const second = await fetchJson(port, "/v1/health", {
      headers: authHeaders("1234567890"),
    });
    expect(second.status).toBe(200);
  });

  it("unauthenticated unknown paths also return 401", async () => {
    const { port, logs } = await startServer();
    const { status, body } = await fetchJson(port, "/v1/not-a-route");
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: "unauthorized" } });
    expect(logs.some((e) => e.code === "auth_failed" && e.reason === "missing_header")).toBe(true);
  });
});

// ─── Group 3 — health + path/method + Tier B / Tier C (5 cases) ──────────

describe("M1-16 controlapi-server / Group 3 health + path + method", () => {
  it("case 12: GET /v1/health returns {status:'ok', version, uptimeMs}", async () => {
    const { port } = await startServer();
    const { status, body, headers } = await fetchJson(port, "/v1/health", {
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    expect(headers.get("content-type")).toMatch(/^application\/json/);
    expect(headers.get("server")).toMatch(/^aifight-runtime\//);
    expect(body).toMatchObject({
      status: "ok",
    });
    const obj = body as { status: string; version: string; uptimeMs: number };
    expect(typeof obj.version).toBe("string");
    expect(obj.version.length).toBeGreaterThan(0);
    expect(typeof obj.uptimeMs).toBe("number");
    expect(obj.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("case 13: GET /v1/unknown-path returns 404 not_found", async () => {
    const { port } = await startServer();
    const { status, body } = await fetchJson(port, "/v1/unknown-path", {
      headers: authHeaders(),
    });
    expect(status).toBe(404);
    expect(body).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("case 14: POST /v1/health returns 405 method_not_allowed with Allow: GET header", async () => {
    const { port } = await startServer();
    const { status, body, headers } = await fetchJson(port, "/v1/health", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
    });
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("GET");
    expect(body).toMatchObject({
      error: { code: "method_not_allowed" },
    });
  });

  it("case 15: Tier C path /v1/doctor returns 404 not_found (unregistered)", async () => {
    const { port } = await startServer();
    const { status, body } = await fetchJson(port, "/v1/doctor", {
      headers: authHeaders(),
    });
    expect(status).toBe(404);
    expect(body).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("case 16: Tier B POST /v1/agents returns 501 with details.retry_after_milestone='M1-18' (rev2 fix #5 shape)", async () => {
    const { port } = await startServer();
    const { status, body } = await fetchJson(port, "/v1/agents", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(501);
    // Locked shape: details.retry_after_milestone — NOT top-of-error.
    expect(body).toMatchObject({
      error: {
        code: "not_implemented",
        details: { retry_after_milestone: "M1-18" },
      },
    });
    // Negative assertion: retry_after_milestone must NOT be at the
    // top of error (rev2 fix #5).
    const obj = body as { error: { retry_after_milestone?: unknown } };
    expect(obj.error.retry_after_milestone).toBeUndefined();
  });
});

// ─── Group 4 — agents read endpoints (5 cases) ───────────────────────────

describe("M1-16 controlapi-server / Group 4 agents read", () => {
  it("case 17: GET /v1/agents returns sanitized agents array", async () => {
    const snapshots = new Map<string, AgentInstanceSnapshot>([
      ["alpha", makeFakeAgentSnapshot("alpha")],
      ["beta", makeFakeAgentSnapshot("beta")],
    ]);
    const { router } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents", {
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    const obj = body as { agents: ReadonlyArray<{ name: string }> };
    expect(obj.agents).toHaveLength(2);
    expect(obj.agents.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("case 18: GET /v1/agents/missing/status -> RouterAgentNotFoundError -> 404", async () => {
    // Empty snapshots map; getAgent default impl throws
    // RouterAgentNotFoundError; handler must catch via duck-typed
    // kind === "router_agent_not_found" and return 404 (not 500).
    const { router, calls } = makeFakeRouter();
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/missing/status", {
      headers: authHeaders(),
    });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: "not_found" } });
    expect(calls.getAgent).toEqual([{ name: "missing" }]);
  });

  it("case 19: GET /v1/agents/alpha/status returns sanitized snapshot — drops state.lastError / pendingAction / pendingConfirm / lastGameOver / state.transport", async () => {
    const snap = makeFakeAgentSnapshot("alpha", {
      state: makeFakeAgentState({
        agentId: "id-alpha",
        agentName: "alpha",
        lastError: "SECRET_ERROR_MUST_BE_DROPPED",
        pendingAction: {
          type: "action_request",
          data: {
            action: "fold",
            time_remaining_sec: 5,
            match_id: "00000000-0000-4000-8000-000000000000",
            sequence: 1,
            request_id: "00000000-0000-4000-8000-000000000001",
            current_player: "id-alpha",
            legal_actions: [],
          },
        } as unknown as AgentFSMState["pendingAction"],
      }),
    });
    const snapshots = new Map([["alpha", snap]]);
    const { router } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/status", {
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    const obj = body as {
      agent: {
        name: string;
        state: Record<string, unknown>;
      };
    };
    expect(obj.agent.name).toBe("alpha");
    expect(obj.agent.state.phase).toBe("connected");
    expect(obj.agent.state.agentId).toBe("id-alpha");
    // Sanitized fields MUST NOT appear:
    expect(obj.agent.state.lastError).toBeUndefined();
    expect(obj.agent.state.pendingAction).toBeUndefined();
    expect(obj.agent.state.pendingConfirm).toBeUndefined();
    expect(obj.agent.state.lastGameOver).toBeUndefined();
    // state.transport is the FSM's internal value; the snapshot's
    // top-level transport field is the public one. The sanitised
    // state must NOT include the inner transport duplicate.
    expect(obj.agent.state.transport).toBeUndefined();
    // Negative assertion: secret payload absent anywhere in body.
    expect(JSON.stringify(body)).not.toContain("SECRET_ERROR_MUST_BE_DROPPED");
  });

  it("case 20: snapshot.state.activeMatch.sessionId is preserved", async () => {
    const snap = makeFakeAgentSnapshot("alpha", {
      state: makeFakeAgentState({
        agentId: "id-alpha",
        agentName: "alpha",
        activeMatch: {
          sessionId: "session-xyz",
          game: "texas_holdem",
          startedAt: 1_700_000_000_000,
        },
      }),
    });
    const snapshots = new Map([["alpha", snap]]);
    const { router } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/status", {
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    const obj = body as {
      agent: {
        state: { activeMatch?: { sessionId?: string; game?: string } };
      };
    };
    expect(obj.agent.state.activeMatch).toEqual({
      sessionId: "session-xyz",
      game: "texas_holdem",
      startedAt: 1_700_000_000_000,
    });
  });

  it("case 21: router.getAgent throws non-RouterAgentNotFoundError -> 500 internal_error + handler_threw log", async () => {
    // RouterAgentLifecycleError has kind = "router_agent_lifecycle"
    // which is NOT the duck-typed not_found discriminator, so
    // dispatch's generic catch turns it into 500.
    const { router } = makeFakeRouter({
      getAgentImpl: () => {
        throw new RouterAgentLifecycleError(
          "alpha",
          "start",
          new Error("upstream failure"),
        );
      },
    });
    const { port, logs } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/status", {
      headers: authHeaders(),
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: { code: "internal_error" } });
    expect(logs.some((e) => e.code === "handler_threw")).toBe(true);
    // Body must NOT leak the upstream cause stack.
    expect(JSON.stringify(body)).not.toContain("upstream failure");
  });
});

// ─── Group 5 — join / leave queue (4 cases) ──────────────────────────────

describe("M1-16 controlapi-server / Group 5 join + leave queue", () => {
  it("case 22: POST /v1/agents/alpha/join body {game} -> 204 + joinQueue called", async () => {
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router, calls } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status } = await fetchJson(port, "/v1/agents/alpha/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ game: "texas_holdem" }),
    });
    expect(status).toBe(204);
    expect(calls.joinQueue).toEqual([
      { name: "alpha", game: "texas_holdem", mode: undefined, opts: {} },
    ]);
  });

  it("case 22b: POST /v1/agents/alpha/join accepts one_shot and count", async () => {
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router, calls } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status } = await fetchJson(port, "/v1/agents/alpha/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ game: "coup", mode: "ranked", one_shot: true, count: 3 }),
    });
    expect(status).toBe(204);
    expect(calls.joinQueue).toEqual([
      { name: "alpha", game: "coup", mode: "ranked", opts: { oneShot: true, count: 3 } },
    ]);
  });

  it("case 23: POST /v1/agents/alpha/join missing game -> 400 + missing_fields:['game']", async () => {
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router, calls } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ mode: "ranked" }),
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: "bad_request", details: { missing_fields: ["game"] } },
    });
    expect(calls.joinQueue).toEqual([]);
  });

  it("case 24: POST /v1/agents/missing/join -> RouterAgentNotFoundError -> 404", async () => {
    const { router } = makeFakeRouter(); // missing snapshot map -> throw
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/missing/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ game: "texas_holdem" }),
    });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: "not_found" } });
  });

  it("case 25: POST /v1/agents/alpha/leave -> 204 + leaveQueue called (no body parsing)", async () => {
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router, calls } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    // Even sending a body should not error — leave does not call
    // parseJsonBody (rev3 fix #1), so the dispatch finally drain
    // silently discards the bytes.
    const { status } = await fetchJson(port, "/v1/agents/alpha/leave", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ignored: "this body must be ignored" }),
    });
    expect(status).toBe(204);
    expect(calls.leaveQueue).toEqual([{ name: "alpha" }]);
  });
});

// ─── Group 6 — schedule endpoints (16 cases) ─────────────────────────────

describe("M1-16 controlapi-server / Group 6 schedule", () => {
  it("case 26: GET /schedule on never-set + no lookup -> 200 + {schedule:null, snapshot}", async () => {
    const { scheduler } = makeFakeScheduler();
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ schedule: null });
    const obj = body as { schedule: null; snapshot: DailySchedulerSnapshot };
    expect(obj.snapshot.running).toBe(true);
  });

  it("case 27 (rev2 fix #4): GET /schedule with lookup providing cfg returns lookup cfg", async () => {
    const { scheduler } = makeFakeScheduler();
    const initial = makeValidScheduleConfig({ timezone: "Asia/Shanghai" });
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
      scheduleConfigLookup: () => initial,
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    const obj = body as { schedule: DailyScheduleConfig };
    expect(obj.schedule).toEqual(initial);
  });

  it("case 28: POST /schedule with valid body -> 204 + setSchedule called + cache updated", async () => {
    const { scheduler, calls } = makeFakeScheduler();
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const cfg = makeValidScheduleConfig();
    const { status } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(cfg),
    });
    expect(status).toBe(204);
    expect(calls.setSchedule).toHaveLength(1);
    expect(calls.setSchedule[0]).toEqual(cfg);
  });

  it("case 29: GET /schedule after HTTP set returns cache cfg (cache > lookup)", async () => {
    const { scheduler } = makeFakeScheduler();
    const initialFromLookup = makeValidScheduleConfig({ timezone: "Asia/Shanghai" });
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
      scheduleConfigLookup: () => initialFromLookup,
    });
    // HTTP set overrides lookup
    const httpCfg = makeValidScheduleConfig({ timezone: "America/New_York" });
    await fetchJson(port, "/v1/agents/alpha/schedule", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(httpCfg),
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    const obj = body as { schedule: DailyScheduleConfig };
    expect(obj.schedule.timezone).toBe("America/New_York");
  });

  it("case 30: POST /schedule missing timezone -> 400 + missing_fields:['timezone']", async () => {
    const { scheduler, calls } = makeFakeScheduler();
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, days: {} }),
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "bad_request",
        details: { missing_fields: ["timezone"] },
      },
    });
    expect(calls.setSchedule).toEqual([]);
  });

  it("case 31: POST /schedule + setSchedule throws invalid_timezone -> 400 + details.validation", async () => {
    const { scheduler } = makeFakeScheduler({
      setScheduleImpl: () => {
        throw new DailySchedulerError(
          "invalid_timezone",
          "timezone 'Mars/Olympus' is not recognised",
        );
      },
    });
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(makeValidScheduleConfig({ timezone: "Mars/Olympus" })),
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "bad_request",
        details: { validation: "invalid_timezone" },
      },
    });
  });

  it("case 32: POST /schedule + setSchedule throws invalid_count -> 400 + details.validation", async () => {
    const { scheduler } = makeFakeScheduler({
      setScheduleImpl: () => {
        throw new DailySchedulerError(
          "invalid_count",
          "count must be a non-negative integer",
        );
      },
    });
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(makeValidScheduleConfig()),
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "bad_request",
        details: { validation: "invalid_count" },
      },
    });
  });

  it("case 33 (rev2 fix #3): POST /schedule + setSchedule throws invalid_state -> 503 service_unavailable", async () => {
    const { scheduler } = makeFakeScheduler({
      setScheduleImpl: () => {
        throw new DailySchedulerError(
          "invalid_state",
          "scheduler is stopped",
        );
      },
    });
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(makeValidScheduleConfig()),
    });
    expect(status).toBe(503);
    expect(body).toMatchObject({
      error: { code: "service_unavailable", message: "scheduler stopped" },
    });
  });

  it("case 34: POST /schedule body literal `null` -> setSchedule(null) + 204 + cache stores null", async () => {
    const { scheduler, calls } = makeFakeScheduler();
    const lookupSpy: DailyScheduleConfig | null = makeValidScheduleConfig();
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
      // lookup provides a non-null cfg; after explicit POST body=null
      // a subsequent GET must NOT fall back to lookup (cache hit
      // value of null wins via Map.has() check).
      scheduleConfigLookup: () => lookupSpy,
    });
    const { status: setStatus } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: "null",
    });
    expect(setStatus).toBe(204);
    expect(calls.setSchedule).toEqual([null]);
    // Verify cache returns null (not lookup fallback) on subsequent GET.
    const { status: getStatus, body: getBody } = await fetchJson(
      port,
      "/v1/agents/alpha/schedule",
      { headers: authHeaders() },
    );
    expect(getStatus).toBe(200);
    expect(getBody).toMatchObject({ schedule: null });
  });

  it("case 35 (rev3 fix #1): POST /schedule empty body -> 400 'request body required' + setSchedule NOT called", async () => {
    const { scheduler, calls } = makeFakeScheduler();
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      // no body
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: "bad_request", message: "request body required" },
    });
    // CRITICAL rev3 fix #1 contract: empty body must NOT silently
    // trigger setSchedule(null), which would clear the daily.
    expect(calls.setSchedule).toEqual([]);
  });

  it("case 36: POST /pause cache miss + no lookup -> 400 bad_request", async () => {
    const { scheduler, calls } = makeFakeScheduler();
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
      // no scheduleConfigLookup
    });
    const { status, body } = await fetchJson(
      port,
      "/v1/agents/alpha/schedule/pause",
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(calls.setSchedule).toEqual([]);
  });

  it("case 37 (rev2 fix #4): POST /pause cache miss + lookup provides cfg -> 204 + setSchedule({...lookup, enabled:false}) + cache", async () => {
    const { scheduler, calls } = makeFakeScheduler();
    const initial = makeValidScheduleConfig({ timezone: "Asia/Shanghai" });
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
      scheduleConfigLookup: () => initial,
    });
    const { status } = await fetchJson(
      port,
      "/v1/agents/alpha/schedule/pause",
      { method: "POST", headers: authHeaders() },
    );
    expect(status).toBe(204);
    expect(calls.setSchedule).toHaveLength(1);
    expect(calls.setSchedule[0]).toEqual({ ...initial, enabled: false });
    // Subsequent GET should now reflect paused (cache cfg wins
    // over lookup, even though lookup returned enabled:true).
    const { body: getBody } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      headers: authHeaders(),
    });
    const obj = getBody as { schedule: DailyScheduleConfig };
    expect(obj.schedule.enabled).toBe(false);
  });

  it("case 38: POST /resume after pause -> setSchedule({...cache, enabled:true})", async () => {
    const { scheduler, calls } = makeFakeScheduler();
    const initial = makeValidScheduleConfig();
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
      scheduleConfigLookup: () => initial,
    });
    // Pause first
    await fetchJson(port, "/v1/agents/alpha/schedule/pause", {
      method: "POST",
      headers: authHeaders(),
    });
    // Resume
    const { status } = await fetchJson(
      port,
      "/v1/agents/alpha/schedule/resume",
      { method: "POST", headers: authHeaders() },
    );
    expect(status).toBe(204);
    expect(calls.setSchedule).toHaveLength(2);
    expect(calls.setSchedule[1]).toEqual({ ...initial, enabled: true });
  });

  it("case 39 (rev3 fix #2): GET /v1/agents/missing-scheduler/schedule when schedulerLookup returns null -> 404", async () => {
    // schedulerLookup explicitly returns null for this agent.
    const { port } = await startServer({
      schedulerLookup: () => null,
    });
    const { status, body } = await fetchJson(
      port,
      "/v1/agents/missing-scheduler/schedule",
      { headers: authHeaders() },
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({
      error: {
        code: "not_found",
        message: "agent 'missing-scheduler' has no scheduler",
      },
    });
  });

  it("case 40 (rev3 fix #2): POST /v1/agents/missing-scheduler/schedule body valid + schedulerLookup null -> 404 + setSchedule NOT called", async () => {
    // The handler must throw 404 BEFORE parseJsonBody reads any
    // body — otherwise a missing-scheduler agent could 415 or 400
    // on body shape before even reporting the missing scheduler.
    // Step 3 contract: resolveScheduler runs FIRST.
    const { scheduler, calls } = makeFakeScheduler();
    let lookupCount = 0;
    const { port } = await startServer({
      schedulerLookup: (name) => {
        lookupCount += 1;
        return name === "alpha" ? scheduler : null;
      },
    });
    const { status, body } = await fetchJson(
      port,
      "/v1/agents/missing-scheduler/schedule",
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(makeValidScheduleConfig()),
      },
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: "not_found" } });
    expect(calls.setSchedule).toEqual([]);
    expect(lookupCount).toBeGreaterThanOrEqual(1);
  });

  it("case 41 (rev3 fix #2): schedulerLookup undefined + POST /pause -> 404 (any schedule endpoint)", async () => {
    const { port } = await startServer({
      // no schedulerLookup at all
    });
    const { status, body } = await fetchJson(
      port,
      "/v1/agents/alpha/schedule/pause",
      { method: "POST", headers: authHeaders() },
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: "not_found" } });
  });

  it("case 41b (Step 3b): GET /schedule never leaks lastAttempt.cause; keeps atMs/game/outcome", async () => {
    // M1-15 DailySchedulerLastAttempt.cause is `unknown` and may
    // hold an internal error object with arbitrary enumerable
    // fields (token / stack / apiKey from upstream HTTP error
    // responses, etc.). Step 3b sanitizeSchedulerSnapshot
    // explicitly omits cause from the GET /schedule response,
    // matching the wider M1-16 contract that no `cause` ever
    // reaches the HTTP body (拍板点 #10 + Risks #2 +
    // mapDailySchedulerError).
    //
    // Probe payload: distinctive secret-like fields the test can
    // grep for in the serialised JSON. If any of them appears,
    // the regression is back.
    const probeSecret = "SECRET_API_KEY_DO_NOT_LEAK";
    const probeStack = "Error: at /upstream/auth/login (REDACTED)";
    const { scheduler } = makeFakeScheduler({
      snapshot: makeFakeSchedulerSnapshot({
        lastAttempt: {
          atMs: 1_700_000_000_000,
          game: "texas_holdem",
          outcome: "join_threw",
          cause: {
            apiKey: probeSecret,
            stack: probeStack,
            // also include a benign field to confirm our test
            // probes actually populate the body shape we expect.
            innerMessage: "upstream rejected our request",
          },
        },
      }),
    });
    const { port } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const { status, body, headers } = await fetchJson(
      port,
      "/v1/agents/alpha/schedule",
      { headers: authHeaders() },
    );
    expect(status).toBe(200);
    expect(headers.get("content-type")).toMatch(/^application\/json/);

    const obj = body as {
      schedule: DailyScheduleConfig | null;
      snapshot: {
        running: boolean;
        today: string | null;
        remaining: Record<string, number>;
        nextFireInMs: number | null;
        lastAttempt: Record<string, unknown> | null;
      };
    };

    // Positive: the safe lastAttempt fields survive sanitisation.
    expect(obj.snapshot.lastAttempt).not.toBeNull();
    expect(obj.snapshot.lastAttempt).toEqual({
      atMs: 1_700_000_000_000,
      game: "texas_holdem",
      outcome: "join_threw",
    });
    expect(Object.prototype.hasOwnProperty.call(obj.snapshot.lastAttempt!, "cause")).toBe(false);

    // Negative: nothing in the entire response body should reveal
    // the probe secret OR the probe stack OR the literal key
    // "cause". A single grep over the serialised JSON catches any
    // future code path (spread, JSON.stringify replacer, etc.)
    // that reintroduces the leak.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(probeSecret);
    expect(serialized).not.toContain(probeStack);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("innerMessage");
    // cause should never appear as a key on lastAttempt; we look
    // for the literal string `"cause"` (with quotes) so that the
    // test is not defeated by stray substrings inside other field
    // values.
    expect(serialized).not.toContain('"cause"');

    // Sibling snapshot fields still pass through unchanged.
    expect(obj.snapshot.running).toBe(true);
    expect(obj.snapshot.today).toBe("2026-04-27");
    expect(obj.snapshot.remaining).toEqual({ texas_holdem: 3 });
    expect(obj.snapshot.nextFireInMs).toBe(60_000);
  });
});

// ─── Group 7 — body limits + Content-Type (5 cases) ──────────────────────

describe("M1-16 controlapi-server / Group 7 body limits + Content-Type", () => {
  it("case 42: POST /v1/agents/alpha/join missing Content-Type -> 415", async () => {
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    // Use raw fetch with explicit empty content-type by sending a
    // GET-like POST without setting headers. Native fetch will set
    // a default content-type when body is a string ("text/plain"),
    // so we send a Uint8Array which keeps content-type unset.
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents/alpha/join`, {
      method: "POST",
      headers: authHeaders(),
      body: new Uint8Array([0x7b, 0x7d]), // "{}"
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsupported_media_type");
  });

  it("case 43: POST /v1/agents/alpha/join Content-Type: text/plain -> 415", async () => {
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "text/plain" },
      body: "{}",
    });
    expect(status).toBe(415);
    expect(body).toMatchObject({
      error: { code: "unsupported_media_type" },
    });
  });

  it("case 44 (rev3 fix #4): POST body > bodyLimitBytes -> client receives complete HTTP 413 + parsable JSON (NOT ECONNRESET)", async () => {
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router, bodyLimitBytes: 1024 });
    // Build a 2 KiB body. Critical assertion: fetch must RESOLVE
    // (not throw network error) AND status must be 413 with a
    // parsable JSON body. rev3 fix #4 forbids req.destroy() prior
    // to writeError completing — without that fix the client would
    // see ECONNRESET and fetch().json() would throw or the response
    // would be partial.
    const huge = "x".repeat(2048);
    let res: Response;
    let networkError: unknown = null;
    try {
      res = await fetch(`http://127.0.0.1:${port}/v1/agents/alpha/join`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ pad: huge }),
      });
    } catch (e) {
      networkError = e;
      throw new Error(
        `fetch threw network error instead of receiving HTTP 413: ${String(e)}`,
      );
    }
    expect(networkError).toBeNull();
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  it("case 45: POST /v1/agents/alpha/join invalid JSON -> 400 'invalid JSON: ...'", async () => {
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "bad_request" } });
    const obj = body as { error: { message: string } };
    expect(obj.error.message).toMatch(/^invalid JSON:/);
  });

  it("case 46 (rev3 fix #1): POST /v1/agents/alpha/join empty body -> 400 'request body required'", async () => {
    // Mirrors the schedule case 35 contract on the /join endpoint:
    // the same parseJsonBody empty-body 400 contract applies to
    // every endpoint that calls parseJsonBody.
    const snapshots = new Map([["alpha", makeFakeAgentSnapshot("alpha")]]);
    const { router, calls } = makeFakeRouter({ snapshots });
    const { port } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      // no body
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: "bad_request", message: "request body required" },
    });
    expect(calls.joinQueue).toEqual([]);
  });
});

// ─── Group 8 — shutdown + logging (6 cases) ──────────────────────────────
//
// rev4 onShutdown wrap contract (locked in M1-16.md rev4 拍板点 #1
// row 10 + types.ts onShutdown JSDoc + Step 4 server.ts
// handleShutdown):
//
//   setImmediate(() => {
//     Promise.resolve()
//       .then(() => opts.onShutdown?.())
//       .catch((cause) => safeLog({code:"handler_threw", ...}));
//   });
//
// Cases 49 + 50 are the explicit rev4 vs rev3 regressions:
//   - case 49: async reject — rev3 + rev4 both catch; spy locks
//     unhandledRejection 0 times.
//   - case 50: sync throw — ONLY rev4 catches (the rev3 form
//     evaluates opts.onShutdown?.() before Promise.resolve and the
//     sync throw escapes setImmediate as uncaughtException). Spy
//     locks uncaughtException 0 times — if Step 4 ever regressed
//     to the rev3 shape, this case would fail immediately.

// Helper: wait for setImmediate + microtask + any deferred
// process events to settle. The shutdown wrap fires onShutdown
// inside a setImmediate callback, then a microtask, then
// potentially an unhandledRejection / uncaughtException event on
// next tick. 50ms is well past all of those on a quiet test
// runner.
async function waitForDeferred(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("M1-16 controlapi-server / Group 8 shutdown + logging", () => {
  it("case 47: POST /v1/shutdown returns 200 + {status:'shutting_down'} + onShutdown called once + shutdown_requested log", async () => {
    const onShutdown = vi.fn(() => undefined);
    const { port, logs } = await startServer({ onShutdown });
    const { status, body } = await fetchJson(port, "/v1/shutdown", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "shutting_down" });
    await waitForDeferred();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(logs.some((e) => e.code === "shutdown_requested")).toBe(true);
  });

  it("case 48: POST /v1/shutdown without onShutdown -> 200 (no throw)", async () => {
    // No onShutdown injected — handler must not crash.
    const { port, logs } = await startServer({});
    const { status, body } = await fetchJson(port, "/v1/shutdown", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "shutting_down" });
    await waitForDeferred();
    // shutdown_requested still fires; no handler_threw because the
    // optional chain `opts.onShutdown?.()` short-circuits silently.
    expect(logs.some((e) => e.code === "shutdown_requested")).toBe(true);
    expect(logs.some((e) => e.code === "handler_threw")).toBe(false);
  });

  it("case 49 (rev4): onShutdown returns Promise.reject -> client gets 200 + handler_threw log + NO unhandledRejection", async () => {
    const rejectionCause = new Error("daemon stop failed (async)");
    const onShutdown = vi.fn(() => Promise.reject(rejectionCause));
    const unhandledRejectionSpy = vi.fn();
    const uncaughtExceptionSpy = vi.fn();
    process.on("unhandledRejection", unhandledRejectionSpy);
    process.on("uncaughtException", uncaughtExceptionSpy);

    try {
      const { port, logs } = await startServer({ onShutdown });
      const { status, body } = await fetchJson(port, "/v1/shutdown", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(status).toBe(200);
      expect(body).toEqual({ status: "shutting_down" });

      await waitForDeferred();

      expect(onShutdown).toHaveBeenCalledTimes(1);
      expect(unhandledRejectionSpy).not.toHaveBeenCalled();
      expect(uncaughtExceptionSpy).not.toHaveBeenCalled();
      const handlerThrew = logs.filter((e) => e.code === "handler_threw");
      expect(handlerThrew).toHaveLength(1);
      expect(handlerThrew[0]?.level).toBe("error");
      expect(handlerThrew[0]?.cause).toBe(rejectionCause);
      expect(handlerThrew[0]?.path).toBe("/v1/shutdown");
    } finally {
      process.off("unhandledRejection", unhandledRejectionSpy);
      process.off("uncaughtException", uncaughtExceptionSpy);
    }
  });

  it("case 50 (rev4 CRITICAL — rev3 shape would FAIL this): onShutdown synchronously throws -> client gets 200 + handler_threw log + NO uncaughtException + NO unhandledRejection", async () => {
    // This is THE case that locks the rev4 vs rev3 difference. If
    // handleShutdown ever regresses to the rev3 form
    // `Promise.resolve(opts.onShutdown?.()).catch(...)`, the sync
    // throw would bubble out of the setImmediate callback as an
    // uncaughtException (Node default exit 1) and the spy below
    // would fire. The .then(() => opts.onShutdown?.()) shape
    // captures the sync throw inside the .then handler and turns
    // it into a rejected Promise that .catch handles.
    const throwCause = new Error("daemon stop failed (sync throw)");
    const onShutdown = vi.fn(() => {
      throw throwCause;
    });
    const unhandledRejectionSpy = vi.fn();
    const uncaughtExceptionSpy = vi.fn();
    process.on("unhandledRejection", unhandledRejectionSpy);
    process.on("uncaughtException", uncaughtExceptionSpy);

    try {
      const { port, logs } = await startServer({ onShutdown });
      const { status, body } = await fetchJson(port, "/v1/shutdown", {
        method: "POST",
        headers: authHeaders(),
      });
      // Client must still see 200 — the response is flushed before
      // setImmediate fires onShutdown. A regression that makes
      // setImmediate throw would crash the socket BEFORE the
      // response, but the writeJson call already completed
      // synchronously inside handleShutdown so the response is
      // safe regardless of the wrap shape.
      expect(status).toBe(200);
      expect(body).toEqual({ status: "shutting_down" });

      await waitForDeferred();

      expect(onShutdown).toHaveBeenCalledTimes(1);
      // THE rev4 assertion: no uncaughtException must fire.
      expect(uncaughtExceptionSpy).not.toHaveBeenCalled();
      // Defensive: the wrap also must not emit unhandledRejection.
      expect(unhandledRejectionSpy).not.toHaveBeenCalled();
      const handlerThrew = logs.filter((e) => e.code === "handler_threw");
      expect(handlerThrew).toHaveLength(1);
      expect(handlerThrew[0]?.cause).toBe(throwCause);

      // Server must still be serving — issue a follow-up request
      // (independent of shutdown) to confirm the process is intact.
      const follow = await fetchJson(port, "/v1/health", {
        headers: authHeaders(),
      });
      expect(follow.status).toBe(200);
    } finally {
      process.off("unhandledRejection", unhandledRejectionSpy);
      process.off("uncaughtException", uncaughtExceptionSpy);
    }
  });

  it("case 51: full lifecycle covers server_listening / request_received / request_completed / auth_failed / handler_threw / shutdown_requested / server_closed", async () => {
    const onShutdown = vi.fn(() => Promise.reject(new Error("trigger handler_threw")));
    const unhandledRejectionSpy = vi.fn();
    process.on("unhandledRejection", unhandledRejectionSpy);
    try {
      const { server, port, logs } = await startServer({ onShutdown });
      // server_listening fires from listen() inside startServer.

      // request_received + request_completed pair on a normal
      // request.
      const ok = await fetchJson(port, "/v1/health", { headers: authHeaders() });
      expect(ok.status).toBe(200);

      // auth_failed via unauthenticated request.
      const bad = await fetchJson(port, "/v1/health");
      expect(bad.status).toBe(401);

      // shutdown_requested + handler_threw via shutdown rejection.
      const sd = await fetchJson(port, "/v1/shutdown", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(sd.status).toBe(200);
      await waitForDeferred();

      // server_closed via close().
      await server.close();
      activeServers.delete(server);

      const codes = new Set(logs.map((e) => e.code));
      expect(codes.has("server_listening")).toBe(true);
      expect(codes.has("request_received")).toBe(true);
      expect(codes.has("request_completed")).toBe(true);
      expect(codes.has("auth_failed")).toBe(true);
      expect(codes.has("shutdown_requested")).toBe(true);
      expect(codes.has("handler_threw")).toBe(true);
      expect(codes.has("server_closed")).toBe(true);
      expect(unhandledRejectionSpy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejectionSpy);
    }
  });

  it("case 52: onLog throw does NOT crash the server — subsequent requests still succeed", async () => {
    // onLog throws on every call. safeLog() wraps the invocation
    // in try/catch and silently swallows; the request lifecycle
    // must not observe the error.
    const onLog = vi.fn(() => {
      throw new Error("onLog deliberately broken for this test");
    });
    const { port } = await startServer({ onLog });
    const first = await fetchJson(port, "/v1/health", {
      headers: authHeaders(),
    });
    expect(first.status).toBe(200);
    expect(onLog).toHaveBeenCalled();
    // Issue several follow-ups to confirm the server stays alive.
    for (let i = 0; i < 3; i++) {
      const next = await fetchJson(port, "/v1/health", {
        headers: authHeaders(),
      });
      expect(next.status).toBe(200);
    }
  });
});

// ─── Group 9 — handler throw safety (3 cases) ────────────────────────────

describe("M1-16 controlapi-server / Group 9 handler safety", () => {
  it("case 53: router.joinQueue throws non-RouterError generic Error -> 500 internal_error + handler_threw + body does NOT leak stack", async () => {
    // RouterAgentLifecycleError is one path (Group 4 case 21);
    // here we use a plain Error with a distinctive secret-like
    // message to confirm the dispatch generic catch sanitises the
    // body output. The handler_threw log keeps the cause for
    // operator forensics, but the HTTP response body must NOT
    // contain it.
    const probeMessage = "INTERNAL_LEAK_PROBE_1234567890_SHOULD_NOT_REACH_BODY";
    const { router } = makeFakeRouter({
      joinQueueImpl: () => {
        throw new TypeError(probeMessage);
      },
    });
    const { port, logs } = await startServer({ router });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ game: "texas_holdem" }),
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: { code: "internal_error" } });
    // Critical: no probe message anywhere in serialised body.
    expect(JSON.stringify(body)).not.toContain(probeMessage);
    // Cause is logged for operators (level: error).
    const handlerThrew = logs.filter((e) => e.code === "handler_threw");
    expect(handlerThrew).toHaveLength(1);
    expect(handlerThrew[0]?.level).toBe("error");
    // The cause object itself round-trips to the log (operators
    // can read the stack from there); only the HTTP body is
    // sanitised.
    const cause = handlerThrew[0]?.cause as Error | undefined;
    expect(cause).toBeInstanceOf(TypeError);
    expect(cause?.message).toBe(probeMessage);
  });

  it("case 54: scheduler.snapshot() throws -> 500 internal_error (NOT 404 — distinguishes 'scheduler crashed' from 'no scheduler wired')", async () => {
    // schedulerLookup returns a scheduler whose snapshot throws.
    // resolveScheduler succeeds (the scheduler exists); the throw
    // escapes scheduler.snapshot() into the dispatch generic catch
    // and becomes 500 internal_error. The 404 path is reserved
    // for "schedulerLookup returns null" (Group 6 case 39) so the
    // operator can tell wiring oversight from runtime crash.
    const probeMessage = "SCHEDULER_SNAPSHOT_PROBE_NEVER_LEAK";
    const scheduler: DailyScheduler = {
      start: () => {},
      stop: () => {},
      setSchedule: () => {},
      snapshot: () => {
        throw new Error(probeMessage);
      },
    };
    const { port, logs } = await startServer({
      schedulerLookup: () => scheduler,
    });
    const { status, body } = await fetchJson(port, "/v1/agents/alpha/schedule", {
      headers: authHeaders(),
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: { code: "internal_error" } });
    // Body must not leak the probe.
    expect(JSON.stringify(body)).not.toContain(probeMessage);
    // handler_threw still records the cause for operator forensics.
    expect(logs.some((e) => e.code === "handler_threw")).toBe(true);
  });

  it("case 55: paired disambiguation — schedulerLookup returns null -> 404 / schedulerLookup returns scheduler that throws on snapshot -> 500 (against the SAME endpoint shape)", async () => {
    // Same URL, same method, two different schedulerLookup
    // behaviours -> two different status codes. This is what
    // gives the operator (or the CLI) actionable information:
    //   404 -> wiring oversight, daemon needs to register a
    //          scheduler for this agent
    //   500 -> scheduler crashed mid-call, investigate the
    //          DailyScheduler implementation
    // Without the disambiguation, both cases would collapse into
    // a generic 5xx and the operator would not know whether to
    // look at the daemon config or the scheduler internals.

    // Half a: missing scheduler -> 404
    {
      const { port } = await startServer({
        schedulerLookup: () => null,
      });
      const { status, body } = await fetchJson(
        port,
        "/v1/agents/alpha/schedule",
        { headers: authHeaders() },
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error: { code: "not_found" } });
    }

    // Half b: scheduler exists but snapshot throws -> 500
    {
      const scheduler: DailyScheduler = {
        start: () => {},
        stop: () => {},
        setSchedule: () => {},
        snapshot: () => {
          throw new Error("crashed");
        },
      };
      const { port } = await startServer({
        schedulerLookup: () => scheduler,
      });
      const { status, body } = await fetchJson(
        port,
        "/v1/agents/alpha/schedule",
        { headers: authHeaders() },
      );
      expect(status).toBe(500);
      expect(body).toMatchObject({ error: { code: "internal_error" } });
    }
  });
});
