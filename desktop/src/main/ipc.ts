// D3 — renderer→main IPC handlers (request/response via ipcMain.handle).
//
// Only these three control channels are registered, so the renderer's reachable
// surface is an explicit allowlist. All take no arguments and return a
// secret-free BridgeStatus, so there is no injection surface and nothing
// sensitive crosses the boundary. Main→renderer event streams (status/log/
// trace/server-message) are pushed from main.ts via the host callbacks.

import { app, ipcMain, shell, type IpcMainInvokeEvent } from "electron";

import { getAifightHome } from "@aifight/aifight/store/paths";
import { IPC, type CliOp } from "../shared/ipc";
import type { BridgeHost } from "./bridge-host";
import { authorizeIpcSender } from "./ipc-guard";
import { runCliOp } from "./cli-host";
import { getAutoUpdate, setAutoUpdate } from "./updater";
import { readStrategy, writeStrategy } from "./strategy-host";
import { getUsageOverview } from "./usage-host";
import {
  clearKey,
  deleteProfile,
  getConfig,
  recommendMaxTokensForFamily,
  saveProfile,
  setActive,
  setKey,
  setRoute,
} from "./config-host";

export function registerBridgeIpc(host: BridgeHost): void {
  // Every renderer→main handler goes through this wrapper so it runs ONLY for a
  // call from the top frame of our trusted renderer page (authorizeIpcSender).
  // A renderer-side injection or a stray frame gets a rejected invoke, never a
  // privileged action. Handlers keep their original (event, ...args) signature.
  const handle = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!authorizeIpcSender(event)) throw new Error("unauthorized ipc sender");
      return fn(event, ...args);
    });
  };

  // Re-reads the shared bridge.json each call, so the renderer sees fresh state
  // after register/connect (which write it) without restarting the app.
  handle(IPC.getStatus, () => host.readConfigSummary());
  handle(IPC.start, () => host.start());
  handle(IPC.stop, () => host.stop());
  handle(IPC.removeLocalIdentity, () => host.removeLocalIdentity());

  // Request manual ranked matches through the in-process bridge. Returns a
  // result instead of throwing so the renderer can surface "not online yet" etc.
  // The game is a plain string — the SERVER validates live-ness.
  handle(IPC.requestMatches, (_e, game: string, count: number) => {
    try {
      host.requestManualMatches(game, "ranked", count);
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  // The platform's CURRENT live games (backend = single source, cached in the
  // host from the welcome frame / GET /api/games; local fallback while offline).
  handle(IPC.gamesGet, () => host.getLiveGames());

  // Live connection-health for the diagnostics panel (in-memory; no disk/network).
  handle(IPC.getConnection, () => host.getConnectionHealth());

  // The agent's public identity + record (post-claim name + win/loss/rating). name
  // null while unclaimed → renderer falls back to the local bootstrap name.
  handle(IPC.getProfile, () => host.getAgentProfile());
  // Full own-agent profile JSON for the rich home view (ratings / history / summary).
  handle(IPC.getProfileRaw, () => host.getOwnProfileRaw());
  // Ability-hexagon self-view (agent key; null-safe on old servers / switch off).
  handle(IPC.getOwnRadar, (_e, game: unknown) =>
    host.getOwnRadar(typeof game === "string" && game !== "" ? game : undefined),
  );

  // Rate policy (server is the source of truth; reflects Dashboard edits).
  handle(IPC.getPolicy, () => host.getAgentPolicy());
  handle(IPC.setPolicy, (_e, patch: unknown) => host.setAgentPolicy((patch ?? {}) as never));
  // Display-name rename (agent-key PATCH; server enforces cooldown + audit).
  handle(IPC.setAgentName, (_e, patch: unknown) => host.setAgentName((patch ?? {}) as never));

  // Avatar (agent-self, bridge-key auth). The renderer sends a preset id or, for
  // an upload, the raw image bytes (ArrayBuffer) + content type.
  handle(IPC.avatarSet, (_e, presetId: unknown) =>
    host.setAgentAvatar(typeof presetId === "string" && presetId !== "" ? presetId : null));
  handle(IPC.avatarClear, () => host.clearAgentAvatar());
  handle(IPC.avatarUpload, (_e, bytes: unknown, contentType: unknown) =>
    host.uploadAgentAvatar(
      bytes instanceof ArrayBuffer ? bytes : new ArrayBuffer(0),
      typeof contentType === "string" ? contentType : "",
    ));

  // Public ranking board (no auth). scope = "all" (cross-game) or a live game name.
  handle(IPC.leaderboardGet, (_e, scope: unknown) =>
    host.getLeaderboard(typeof scope === "string" && scope !== "" ? scope : "all"),
  );

  // Public events list (no auth). Registration is deep-linked to the web by the renderer.
  handle(IPC.eventsGet, () => host.getEvents());

  // Open the agent's claim page in the user's browser (claim link embeds a token,
  // so main opens it directly — the URL is never returned to the renderer).
  handle(IPC.openClaim, () => {
    const url = host.getClaimTarget();
    if (url === null) return { ok: false };
    void shell.openExternal(url);
    return { ok: true };
  });

  // Open the owner Dashboard in the user's browser already logged in (passwordless
  // SSO). The handoff URL embeds a one-time credential, so — like the claim link —
  // main mints + opens it here and returns ONLY {ok,error} to the renderer (never
  // the URL). On any handoff failure it opens the bare dashboard (login page).
  handle(IPC.openDashboard, async () => {
    const target = await host.getDashboardTarget();
    const toOpen = target.url ?? target.fallback;
    if (toOpen !== null) void shell.openExternal(toOpen);
    return { ok: target.url !== null, ...(target.url === null ? { error: target.error } : {}) };
  });

  // Record the owner's acceptance of the current Terms/Privacy in-app (no browser).
  handle(IPC.acceptLegal, () => host.acceptLegal());

  // Open the public Terms / Privacy page on the paired host so the user can read
  // the full document before accepting. `kind` is validated to a fixed enum and
  // the URL is host-checked in legalDocUrl before it reaches shell.openExternal.
  handle(IPC.openLegal, (_e, kind: unknown) => {
    if (kind !== "terms" && kind !== "privacy") return { ok: false };
    const url = host.legalDocUrl(kind);
    if (url === null) return { ok: false };
    void shell.openExternal(url);
    return { ok: true };
  });

  // Open the shared ~/.aifight config folder in the OS file manager (for backup /
  // inspecting keys + strategy). Resolved via the runtime path helper — never a
  // hardcoded path. shell.openPath resolves to "" on success or an error string.
  handle(IPC.openConfigDir, () => shell.openPath(getAifightHome()));

  // Local token usage (§7A) for the home dashboard — same ledger + price table
  // as `aifight stats`. Local reads only; estimated costs never leave the machine.
  handle(IPC.usageGet, () => {
    try {
      return getUsageOverview();
    } catch {
      return null;
    }
  });

  // Pause/resume automatic matchmaking (leave/re-enter the pool) without going
  // offline. Session-only: the renderer always starts un-paused each launch.
  handle(IPC.setMatchingPaused, async (_e, paused: unknown) => {
    try {
      await host.setMatchingPaused(paused === true);
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  // Launch-at-login (default off). Uses Electron's OS login-item registration —
  // this is the app auto-starting, NOT a headless background service.
  handle(IPC.loginItemGet, () => app.getLoginItemSettings().openAtLogin);
  handle(IPC.loginItemSet, (_e, enabled: unknown) => {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled === true });
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  // Auto-update opt-in (default OFF = fail-closed). getAutoUpdate reflects the
  // persisted flag; setAutoUpdate persists it and applies the electron-updater
  // settings immediately (see updater.ts). Mirrors the loginItem pair above.
  handle(IPC.getAutoUpdate, () => getAutoUpdate());
  handle(IPC.setAutoUpdate, (_e, enabled: unknown) => {
    setAutoUpdate(enabled === true);
    return { ok: true };
  });

  // Full CLI parity via a TYPED, enumerated operation: the renderer names WHICH
  // operation it wants (CliOp), and main builds the fixed argv template per kind
  // (cli-host.ts). The renderer can never compose arbitrary argv/flags, and every
  // interpolated value is validated before it reaches the CLI's run().
  handle(IPC.cliOp, (_e, op: unknown) => runCliOp(op as CliOp));

  // Strategy editor: read/write the agent's own strategy Markdown — the SAME
  // files the runtime injects into prompts during matches. Local files only.
  // Per-game scopes follow the host's live-game cache (backend-fed; falls back
  // to the local list while offline, so editing keeps working without a network).
  handle(IPC.strategyRead, () => readStrategy(host.liveGamesSync()));
  handle(IPC.strategyWrite, (_e, scope: unknown, content: unknown) =>
    writeStrategy(host.liveGamesSync(), scope, content),
  );

  // Graphical LLM config (standalone — no CLI). Reads/writes the SAME agent
  // config.json the CLI uses; setKey takes the raw key over IPC and stores it
  // to a 0600 file (never argv, never returned to the renderer).
  handle(IPC.configGet, () => getConfig());
  handle(IPC.configRecommendMaxTokens, (_e, input: unknown) => recommendMaxTokensForFamily(input as never));
  handle(IPC.configSaveProfile, (_e, input: unknown) => saveProfile("default", input as never));
  handle(IPC.configSetKey, (_e, profileId: unknown, apiKey: unknown) => setKey("default", profileId, apiKey));
  handle(IPC.configClearKey, (_e, profileId: unknown) => clearKey("default", profileId));
  handle(IPC.configSetActive, (_e, profileId: unknown) => setActive("default", profileId));
  handle(IPC.configSetRoute, (_e, game: unknown, profileId: unknown) => setRoute("default", game, profileId));
  handle(IPC.configDeleteProfile, (_e, profileId: unknown) => deleteProfile("default", profileId));
}
