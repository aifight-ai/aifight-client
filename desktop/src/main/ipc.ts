// D3 — renderer→main IPC handlers (request/response via ipcMain.handle).
//
// Only these three control channels are registered, so the renderer's reachable
// surface is an explicit allowlist. All take no arguments and return a
// secret-free BridgeStatus, so there is no injection surface and nothing
// sensitive crosses the boundary. Main→renderer event streams (status/log/
// trace/server-message) are pushed from main.ts via the host callbacks.

import { app, ipcMain, shell } from "electron";

import { getAifightHome } from "@aifight/aifight/store/paths";
import { IPC } from "../shared/ipc";
import type { BridgeHost } from "./bridge-host";
import { runCli } from "./cli-host";
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
  // Re-reads the shared bridge.json each call, so the renderer sees fresh state
  // after register/connect (which write it) without restarting the app.
  ipcMain.handle(IPC.getStatus, () => host.readConfigSummary());
  ipcMain.handle(IPC.start, () => host.start());
  ipcMain.handle(IPC.stop, () => host.stop());

  // Request manual ranked matches through the in-process bridge. Returns a
  // result instead of throwing so the renderer can surface "not online yet" etc.
  // The game is a plain string — the SERVER validates live-ness.
  ipcMain.handle(IPC.requestMatches, (_e, game: string, count: number) => {
    try {
      host.requestManualMatches(game, "ranked", count);
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  // The platform's CURRENT live games (backend = single source, cached in the
  // host from the welcome frame / GET /api/games; local fallback while offline).
  ipcMain.handle(IPC.gamesGet, () => host.getLiveGames());

  // Live connection-health for the diagnostics panel (in-memory; no disk/network).
  ipcMain.handle(IPC.getConnection, () => host.getConnectionHealth());

  // The agent's public identity + record (post-claim name + win/loss/rating). name
  // null while unclaimed → renderer falls back to the local bootstrap name.
  ipcMain.handle(IPC.getProfile, () => host.getAgentProfile());
  // Full own-agent profile JSON for the rich home view (ratings / history / summary).
  ipcMain.handle(IPC.getProfileRaw, () => host.getOwnProfileRaw());
  // Ability-hexagon self-view (agent key; null-safe on old servers / switch off).
  ipcMain.handle(IPC.getOwnRadar, (_e, game: unknown) =>
    host.getOwnRadar(typeof game === "string" && game !== "" ? game : undefined),
  );

  // Rate policy (server is the source of truth; reflects Dashboard edits).
  ipcMain.handle(IPC.getPolicy, () => host.getAgentPolicy());
  ipcMain.handle(IPC.setPolicy, (_e, patch: unknown) => host.setAgentPolicy((patch ?? {}) as never));
  // Display-name rename (agent-key PATCH; server enforces cooldown + audit).
  ipcMain.handle(IPC.setAgentName, (_e, patch: unknown) => host.setAgentName((patch ?? {}) as never));

  // Avatar (agent-self, bridge-key auth). The renderer sends a preset id or, for
  // an upload, the raw image bytes (ArrayBuffer) + content type.
  ipcMain.handle(IPC.avatarSet, (_e, presetId: unknown) =>
    host.setAgentAvatar(typeof presetId === "string" && presetId !== "" ? presetId : null));
  ipcMain.handle(IPC.avatarClear, () => host.clearAgentAvatar());
  ipcMain.handle(IPC.avatarUpload, (_e, bytes: unknown, contentType: unknown) =>
    host.uploadAgentAvatar(
      bytes instanceof ArrayBuffer ? bytes : new ArrayBuffer(0),
      typeof contentType === "string" ? contentType : "",
    ));

  // Public ranking board (no auth). scope = "all" (cross-game) or a live game name.
  ipcMain.handle(IPC.leaderboardGet, (_e, scope: unknown) =>
    host.getLeaderboard(typeof scope === "string" && scope !== "" ? scope : "all"),
  );

  // Public events list (no auth). Registration is deep-linked to the web by the renderer.
  ipcMain.handle(IPC.eventsGet, () => host.getEvents());

  // Open the agent's claim page in the user's browser (claim link embeds a token,
  // so main opens it directly — the URL is never returned to the renderer).
  ipcMain.handle(IPC.openClaim, () => {
    const url = host.getClaimTarget();
    if (url === null) return { ok: false };
    void shell.openExternal(url);
    return { ok: true };
  });

  // Open the owner Dashboard in the user's browser already logged in (passwordless
  // SSO). The handoff URL embeds a one-time credential, so — like the claim link —
  // main mints + opens it here and returns ONLY {ok,error} to the renderer (never
  // the URL). On any handoff failure it opens the bare dashboard (login page).
  ipcMain.handle(IPC.openDashboard, async () => {
    const target = await host.getDashboardTarget();
    const toOpen = target.url ?? target.fallback;
    if (toOpen !== null) void shell.openExternal(toOpen);
    return { ok: target.url !== null, ...(target.url === null ? { error: target.error } : {}) };
  });

  // Record the owner's acceptance of the current Terms/Privacy in-app (no browser).
  ipcMain.handle(IPC.acceptLegal, () => host.acceptLegal());

  // Open the public Terms / Privacy page on the paired host so the user can read
  // the full document before accepting. `kind` is validated to a fixed enum and
  // the URL is host-checked in legalDocUrl before it reaches shell.openExternal.
  ipcMain.handle(IPC.openLegal, (_e, kind: unknown) => {
    if (kind !== "terms" && kind !== "privacy") return { ok: false };
    const url = host.legalDocUrl(kind);
    if (url === null) return { ok: false };
    void shell.openExternal(url);
    return { ok: true };
  });

  // Open the shared ~/.aifight config folder in the OS file manager (for backup /
  // inspecting keys + strategy). Resolved via the runtime path helper — never a
  // hardcoded path. shell.openPath resolves to "" on success or an error string.
  ipcMain.handle(IPC.openConfigDir, () => shell.openPath(getAifightHome()));

  // Local token usage (§7A) for the home dashboard — same ledger + price table
  // as `aifight stats`. Local reads only; estimated costs never leave the machine.
  ipcMain.handle(IPC.usageGet, () => {
    try {
      return getUsageOverview();
    } catch {
      return null;
    }
  });

  // Pause/resume automatic matchmaking (leave/re-enter the pool) without going
  // offline. Session-only: the renderer always starts un-paused each launch.
  ipcMain.handle(IPC.setMatchingPaused, async (_e, paused: unknown) => {
    try {
      await host.setMatchingPaused(paused === true);
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  // Launch-at-login (default off). Uses Electron's OS login-item registration —
  // this is the app auto-starting, NOT a headless background service.
  ipcMain.handle(IPC.loginItemGet, () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle(IPC.loginItemSet, (_e, enabled: unknown) => {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled === true });
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  // Full CLI parity: register/connect/config/set/challenge/accept/status/… run
  // in-process and write the SAME shared config the CLI uses.
  ipcMain.handle(IPC.cliRun, (_e, args: unknown) => runCli(args));

  // Strategy editor: read/write the agent's own strategy Markdown — the SAME
  // files the runtime injects into prompts during matches. Local files only.
  // Per-game scopes follow the host's live-game cache (backend-fed; falls back
  // to the local list while offline, so editing keeps working without a network).
  ipcMain.handle(IPC.strategyRead, () => readStrategy(host.liveGamesSync()));
  ipcMain.handle(IPC.strategyWrite, (_e, scope: unknown, content: unknown) =>
    writeStrategy(host.liveGamesSync(), scope, content),
  );

  // Graphical LLM config (standalone — no CLI). Reads/writes the SAME agent
  // config.json the CLI uses; setKey takes the raw key over IPC and stores it
  // to a 0600 file (never argv, never returned to the renderer).
  ipcMain.handle(IPC.configGet, () => getConfig());
  ipcMain.handle(IPC.configRecommendMaxTokens, (_e, input: unknown) => recommendMaxTokensForFamily(input as never));
  ipcMain.handle(IPC.configSaveProfile, (_e, input: unknown) => saveProfile("default", input as never));
  ipcMain.handle(IPC.configSetKey, (_e, profileId: unknown, apiKey: unknown) => setKey("default", profileId, apiKey));
  ipcMain.handle(IPC.configClearKey, (_e, profileId: unknown) => clearKey("default", profileId));
  ipcMain.handle(IPC.configSetActive, (_e, profileId: unknown) => setActive("default", profileId));
  ipcMain.handle(IPC.configSetRoute, (_e, game: unknown, profileId: unknown) => setRoute("default", game, profileId));
  ipcMain.handle(IPC.configDeleteProfile, (_e, profileId: unknown) => deleteProfile("default", profileId));
}
