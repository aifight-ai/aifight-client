// Shared renderer helpers for talking to the main process. Guard window.aifight
// so the renderer also runs in a plain browser (vite dev) without crashing.

import { useEffect, useState } from "react";

import { localizeServerError } from "./errors";
import { FALLBACK_LIVE_GAMES } from "../shared/games";
import type {
  AgentPolicy,
  AgentProfileData,
  BridgeStatus,
  HexagonData,
  CliOp,
  CliRunResult,
  ConfigMutResult,
  RecommendMaxTokensInput,
  RecommendMaxTokensResult,
  ConfigView,
  ConnectionHealth,
  EventsData,
  LeaderboardData,
  LeaderboardScope,
  ProfileInput,
  StrategyReadResult,
  StrategyScope,
  StrategyWriteResult,
  UsageOverview,
} from "../shared/ipc";

const NO_BRIDGE = "desktop bridge unavailable (run inside the app)";

export function useBridgeStatus(): BridgeStatus | null {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  useEffect(() => {
    const api = window.aifight;
    if (api === undefined) return;
    let alive = true;
    void api
      .getStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    const off = api.onStatus((s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

/** Human-readable summary of a CLI run, for the action log. */
export function resultText(r: CliRunResult): string {
  if (r.error !== undefined) return r.error;
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (r.exitCode !== 0) return err || out || `exit ${r.exitCode}`;
  return out || err || "OK";
}

export async function runCli(op: CliOp): Promise<CliRunResult> {
  const api = window.aifight;
  if (api === undefined) {
    return { exitCode: 1, stdout: "", stderr: "", error: "desktop bridge unavailable (run inside the app)" };
  }
  return api.runCli(op);
}

export async function bridgeStart(): Promise<void> {
  await window.aifight?.start();
}
export async function bridgeStop(): Promise<void> {
  await window.aifight?.stop();
}
/** Device-mismatch recovery (F1 takeover, button 2): archive + remove THIS device's
 *  local bridge identity, returning the app to onboarding. Server-side agent/record/
 *  rating are untouched. */
export async function removeLocalIdentity(): Promise<{ ok: boolean; error?: string }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: "desktop bridge unavailable" };
  return api.removeLocalIdentity();
}
export async function requestMatches(game: string, count: number): Promise<{ ok: boolean; error?: string }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: "desktop bridge unavailable" };
  return api.requestMatches(game, count);
}
/** The platform's CURRENT live games (backend-fed main cache; local fallback in plain browser). */
export async function getLiveGames(): Promise<readonly string[]> {
  const api = window.aifight;
  if (api === undefined) return FALLBACK_LIVE_GAMES;
  return api.getLiveGames();
}
export async function setMatchingPaused(paused: boolean): Promise<{ ok: boolean; error?: string }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: "desktop bridge unavailable" };
  return api.setMatchingPaused(paused);
}
export async function getConnectionHealth(): Promise<ConnectionHealth | null> {
  const api = window.aifight;
  if (api === undefined) return null;
  return api.getConnectionHealth();
}
export async function openClaim(): Promise<{ ok: boolean }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false };
  return api.openClaim();
}
/** Open the owner Dashboard in the system browser already logged in (passwordless SSO).
 *  Falls back to the bare dashboard (login page) when the handoff can't complete. */
export async function openDashboard(): Promise<{ ok: boolean; error?: string }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: NO_BRIDGE };
  return api.openDashboard();
}
/** Record the owner's acceptance of the current Terms/Privacy in-app (no browser). */
export async function acceptLegal(): Promise<{ ok: boolean; error?: string }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: NO_BRIDGE };
  return api.acceptLegal();
}
/** Open the public Terms / Privacy page on the paired host to read it in full. */
export async function openLegal(kind: "terms" | "privacy"): Promise<{ ok: boolean }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false };
  return api.openLegal(kind);
}
export async function openConfigDir(): Promise<void> {
  await window.aifight?.openConfigDir();
}
export async function getAgentProfile(): Promise<AgentProfileData> {
  const api = window.aifight;
  if (api === undefined) return { name: null, stats: null };
  return api.getAgentProfile();
}
export async function getOwnProfileRaw(): Promise<Record<string, unknown> | null> {
  const api = window.aifight;
  if (api === undefined) return null;
  return api.getOwnProfileRaw();
}
export async function getOwnRadar(game?: string): Promise<HexagonData | null> {
  const api = window.aifight;
  if (api === undefined) return null;
  return api.getOwnRadar(game);
}
export async function getAgentPolicy(): Promise<AgentPolicy | null> {
  const api = window.aifight;
  if (api === undefined) return null;
  return api.getAgentPolicy();
}
export async function getUsageOverview(): Promise<UsageOverview | null> {
  const api = window.aifight;
  if (api === undefined) return null;
  return api.getUsageOverview();
}
export async function setAgentPolicy(patch: { maxGamesPerDay: number }): Promise<{ ok: boolean; error?: string }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: "desktop bridge unavailable" };
  return api.setAgentPolicy(patch);
}
export async function setAgentName(
  patch: { name: string },
): Promise<{ ok: boolean; error?: string; name?: string; publicNo?: number; nextRenameAllowedAt?: string }> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: "desktop bridge unavailable" };
  return api.setAgentName(patch);
}

/** Avatar mutations bound to the desktop bridge-key IPC, shaped for the shared
 *  web AvatarPicker's injectable `actions` prop (throw on failure → the picker
 *  surfaces the error). Upload reads the chosen File to bytes here so only the
 *  ArrayBuffer crosses IPC. */
export function desktopAvatarActions(): {
  setPreset: (presetId: string) => Promise<void>;
  clear: () => Promise<void>;
  upload: (file: File) => Promise<{ avatar_url: string }>;
} {
  return {
    setPreset: async (presetId: string) => {
      const api = window.aifight;
      if (api === undefined) throw new Error(localizeServerError("bridge unavailable"));
      const r = await api.setAgentAvatar(presetId);
      if (!r.ok) throw new Error(localizeServerError(r.error, "avatarSet"));
    },
    clear: async () => {
      const api = window.aifight;
      if (api === undefined) throw new Error(localizeServerError("bridge unavailable"));
      const r = await api.clearAgentAvatar();
      if (!r.ok) throw new Error(localizeServerError(r.error, "avatarClear"));
    },
    upload: async (file: File) => {
      const api = window.aifight;
      if (api === undefined) throw new Error(localizeServerError("bridge unavailable"));
      const bytes = await file.arrayBuffer();
      const r = await api.uploadAgentAvatar(bytes, file.type);
      if (!r.ok || r.avatar_url === undefined) throw new Error(localizeServerError(r.error, "avatarUpload"));
      return { avatar_url: r.avatar_url };
    },
  };
}
export async function getLeaderboard(scope: LeaderboardScope): Promise<LeaderboardData | null> {
  const api = window.aifight;
  if (api === undefined) return null;
  return api.getLeaderboard(scope);
}
export async function getEvents(): Promise<EventsData | null> {
  const api = window.aifight;
  if (api === undefined) return null;
  return api.getEvents();
}
export async function getLaunchAtLogin(): Promise<boolean> {
  return (await window.aifight?.getLaunchAtLogin()) ?? false;
}
export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  await window.aifight?.setLaunchAtLogin(enabled);
}
/** Whether automatic updates are enabled (default false = fail-closed). */
export async function getAutoUpdate(): Promise<boolean> {
  return (await window.aifight?.getAutoUpdate()) ?? false;
}
/** Enable/disable automatic updates (persisted opt-in). */
export async function setAutoUpdate(enabled: boolean): Promise<void> {
  await window.aifight?.setAutoUpdate(enabled);
}

export async function readStrategy(): Promise<StrategyReadResult> {
  const api = window.aifight;
  if (api === undefined) return { docs: [], maxBytes: 65536, error: "desktop bridge unavailable (run inside the app)" };
  return api.readStrategy();
}

export async function writeStrategy(scope: StrategyScope, content: string): Promise<StrategyWriteResult> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: "desktop bridge unavailable" };
  return api.writeStrategy(scope, content);
}

// ── Graphical LLM config (standalone) ──
export async function getLLMConfig(): Promise<ConfigView> {
  const api = window.aifight;
  if (api === undefined) return { configured: false, slug: "default", activeProfile: "", routing: { default: "" }, profiles: [] };
  return api.getLLMConfig();
}
export async function saveLLMProfile(input: ProfileInput): Promise<ConfigMutResult> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: NO_BRIDGE };
  return api.saveLLMProfile(input);
}
export async function llmRecommendMaxTokens(
  input: RecommendMaxTokensInput,
): Promise<RecommendMaxTokensResult | null> {
  const api = window.aifight;
  if (api === undefined) return null;
  return api.llmRecommendMaxTokens(input);
}
export async function setLLMKey(profileId: string, apiKey: string): Promise<ConfigMutResult> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: NO_BRIDGE };
  return api.setLLMKey(profileId, apiKey);
}
export async function clearLLMKey(profileId: string): Promise<ConfigMutResult> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: NO_BRIDGE };
  return api.clearLLMKey(profileId);
}
export async function setLLMActive(profileId: string): Promise<ConfigMutResult> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: NO_BRIDGE };
  return api.setLLMActive(profileId);
}
export async function setLLMRoute(game: string, profileId: string): Promise<ConfigMutResult> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: NO_BRIDGE };
  return api.setLLMRoute(game, profileId);
}
export async function deleteLLMProfile(profileId: string): Promise<ConfigMutResult> {
  const api = window.aifight;
  if (api === undefined) return { ok: false, error: NO_BRIDGE };
  return api.deleteLLMProfile(profileId);
}
