// Preload: the ONLY bridge between the sandboxed renderer and the main process.
// It exposes a minimal, typed `window.aifight` (the AifightBridgeApi contract)
// built from ipcRenderer.invoke (control) and ipcRenderer.on (event streams).
// The renderer never sees ipcRenderer or Node directly — contextIsolation +
// this allowlist are the security boundary.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  IPC,
  type AifightBridgeApi,
  type BridgeDecisionTrace,
  type BridgeLogEvent,
  type BridgeStatus,
  type ServerMessage,
  type StrategyScope,
  type ProfileInput,
  type UpdateStatus,
} from "../shared/ipc";

// Replaced at build time by esbuild `define` (from package.json version).
declare const __APP_VERSION__: string;

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: AifightBridgeApi = {
  version: __APP_VERSION__,
  // process.platform is available in the sandboxed preload; expose just the string
  // so the renderer can reserve the macOS traffic-light inset.
  platform: process.platform,
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  start: () => ipcRenderer.invoke(IPC.start),
  stop: () => ipcRenderer.invoke(IPC.stop),
  requestMatches: (game: string, count: number) => ipcRenderer.invoke(IPC.requestMatches, game, count),
  getLiveGames: () => ipcRenderer.invoke(IPC.gamesGet),
  getConnectionHealth: () => ipcRenderer.invoke(IPC.getConnection),
  openClaim: () => ipcRenderer.invoke(IPC.openClaim),
  openDashboard: () => ipcRenderer.invoke(IPC.openDashboard),
  getAgentProfile: () => ipcRenderer.invoke(IPC.getProfile),
  getOwnProfileRaw: () => ipcRenderer.invoke(IPC.getProfileRaw),
  getAgentPolicy: () => ipcRenderer.invoke(IPC.getPolicy),
  setAgentPolicy: (patch: { maxGamesPerDay: number }) => ipcRenderer.invoke(IPC.setPolicy, patch),
  setAgentName: (patch: { name: string }) => ipcRenderer.invoke(IPC.setAgentName, patch),
  setAgentAvatar: (presetId: string | null) => ipcRenderer.invoke(IPC.avatarSet, presetId),
  clearAgentAvatar: () => ipcRenderer.invoke(IPC.avatarClear),
  uploadAgentAvatar: (bytes: ArrayBuffer, contentType: string) => ipcRenderer.invoke(IPC.avatarUpload, bytes, contentType),
  getLeaderboard: (scope) => ipcRenderer.invoke(IPC.leaderboardGet, scope),
  getEvents: () => ipcRenderer.invoke(IPC.eventsGet),
  setMatchingPaused: (paused: boolean) => ipcRenderer.invoke(IPC.setMatchingPaused, paused),
  getLaunchAtLogin: () => ipcRenderer.invoke(IPC.loginItemGet),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke(IPC.loginItemSet, enabled),
  focusWindow: () => ipcRenderer.invoke(IPC.focusWindow),
  openConfigDir: () => ipcRenderer.invoke(IPC.openConfigDir),
  cliRun: (args: string[]) => ipcRenderer.invoke(IPC.cliRun, args),
  readStrategy: () => ipcRenderer.invoke(IPC.strategyRead),
  writeStrategy: (scope: StrategyScope, content: string) => ipcRenderer.invoke(IPC.strategyWrite, scope, content),
  getLLMConfig: () => ipcRenderer.invoke(IPC.configGet),
  saveLLMProfile: (input: ProfileInput) => ipcRenderer.invoke(IPC.configSaveProfile, input),
  setLLMKey: (profileId: string, apiKey: string) => ipcRenderer.invoke(IPC.configSetKey, profileId, apiKey),
  clearLLMKey: (profileId: string) => ipcRenderer.invoke(IPC.configClearKey, profileId),
  setLLMActive: (profileId: string) => ipcRenderer.invoke(IPC.configSetActive, profileId),
  setLLMRoute: (game: string, profileId: string) => ipcRenderer.invoke(IPC.configSetRoute, game, profileId),
  deleteLLMProfile: (profileId: string) => ipcRenderer.invoke(IPC.configDeleteProfile, profileId),
  onStatus: (listener) => subscribe<BridgeStatus>(IPC.status, listener),
  onLog: (listener) => subscribe<BridgeLogEvent>(IPC.log, listener),
  onTrace: (listener) => subscribe<BridgeDecisionTrace>(IPC.trace, listener),
  onServerMessage: (listener) => subscribe<ServerMessage>(IPC.serverMessage, listener),
  onNavigate: (listener) => subscribe<string>(IPC.navigate, listener),
  getUsageOverview: () => ipcRenderer.invoke(IPC.usageGet),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  onUpdateStatus: (listener) => subscribe<UpdateStatus>(IPC.updateStatus, listener),
};

contextBridge.exposeInMainWorld("aifight", api);
