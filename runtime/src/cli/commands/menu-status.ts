// The boxed status banner at the top of the interactive panel (owner ask
// 2026-07-30, 3x-ui style: "the top could show agent status").
//
// Data policy:
//   * LOCAL bridge.json + local process probes are always enough to draw the
//     box — the panel never waits on the network for its first paint.
//   * REMOTE facts (authoritative claim state, server-side name, update
//     check) are best-effort: fetched ONCE per panel session with the same
//     ~1.5s budgets `aifight status` uses, in parallel with the first render.
//     When the answers land the chooser repaints the box; when they don't
//     (offline, slow), the local-only box simply stays — no error noise.
//   * "Matches used today" is NOT shown: the platform status endpoint does
//     not expose it and the local scheduler counter lives in the bridge
//     process's memory, so there is no cheap truthful source. The daily cap
//     (auto N/day) is shown instead of a number we would have to guess.
//
// Everything here is injectable/pure except createMenuStatusBox's one config
// read, so banner composition is unit-testable without a terminal or network.

import { checkPlatformAgentStatus } from "../../account/platform-agent-status.js";
import { readBridgeConfig } from "../../bridge/config.js";
import { resolveEffectiveDeclaredModel } from "../../bridge/declared-model.js";
import { checkBridgeUpdate } from "../../bridge/update-check.js";
import { RUNTIME_VERSION } from "../../index.js";
import { SUPPORTED_GAMES } from "../shared.js";
import { agentSeatHolderPid } from "./bridge-start.js";
import type { MenuStatusLine, MenuStatusSegment } from "./menu-frame.js";

export interface MenuStatusData {
  readonly agentName: string;
  /** Locally: the claim URL is scrubbed once a client observes the claim, so
   *  "still on file" reliably means unclaimed (same convention claim-state.ts
   *  documents). Remotely: the platform's authoritative answer. */
  readonly claimed: boolean;
  readonly paused: boolean;
  /** A live bridge process on THIS machine (aifight run / service / desktop
   *  seat holder) — the honest local "is my agent online" signal. */
  readonly online: boolean;
  readonly dailyCap: number | undefined;
  readonly games: readonly string[];
  /** The effective declared model (what the leaderboard shows). */
  readonly model: string;
  /** Set when the update check found a newer CLI — the yellow hint. */
  readonly updateVersion?: string;
}

export interface MenuStatusBoxProvider {
  /** The box border title, e.g. "AIFight · v0.1.0-beta.39". */
  readonly title: string;
  /** Current banner lines — local-only until the one-shot remote refresh
   *  resolves, enriched afterwards. Always the same number of lines, so a
   *  refresh repaint never changes the rendered line count. */
  lines(): readonly MenuStatusLine[];
  /** The one-shot remote refresh while it is still pending; undefined once
   *  settled (or when there was nothing to fetch). Never rejects. */
  refreshed(): Promise<unknown> | undefined;
}

/** Pure line composition — exported so tests assert the exact segments. */
export function composeMenuStatusLines(data: MenuStatusData): readonly MenuStatusLine[] {
  const claim: MenuStatusSegment = data.claimed
    ? { text: "✓ claimed", style: "green" }
    : { text: "⚠ unclaimed", style: "yellow" };
  // Paused wins over online: a paused bridge can be connected yet is NOT
  // matching, and that is the state the user must not miss (a paused agent
  // looks "online" everywhere else — the confusion pause was added to fix).
  const presence: MenuStatusSegment = data.paused
    ? { text: "● paused", style: "yellow" }
    : data.online
      ? { text: "● online", style: "green" }
      : { text: "○ offline", style: "dim" };
  const daily: MenuStatusSegment = {
    text:
      data.dailyCap === undefined
        ? "auto: not set"
        : data.dailyCap === 0
          ? "auto: off"
          : `auto: ${data.dailyCap}/day`,
    style: "dim",
  };
  const line1: MenuStatusLine = [
    { text: data.agentName, style: "bold" },
    { text: " · " },
    claim,
    { text: " · " },
    presence,
    { text: " · " },
    daily,
  ];
  const line2: MenuStatusSegment[] = [
    { text: data.model, style: "cyan" },
  ];
  // The update hint goes BEFORE the games list: when the line must truncate,
  // the games tail (fully visible via item 6 / `aifight status`) is what
  // shortens, never the version itself.
  if (data.updateVersion !== undefined) {
    line2.push({ text: " · " }, { text: `↑ ${data.updateVersion}`, style: "yellow" });
  }
  line2.push(
    { text: " · games: ", style: "dim" },
    { text: data.games.join(", ") },
  );
  return [line1, line2];
}

export interface CreateMenuStatusBoxOptions {
  readonly fetchImpl?: typeof fetch;
  /** Test seam for the local online probe. Default: agentSeatHolderPid. */
  readonly seatHolderPid?: () => number | undefined;
}

/**
 * Build the panel's status box provider from the local bridge config, kicking
 * off the one-shot remote enrichment in the background. Returns undefined
 * when there is no local identity to describe (first run) or the config is
 * unreadable — the panel then draws without the box, as before.
 */
export function createMenuStatusBox(
  opts: CreateMenuStatusBoxOptions = {},
): MenuStatusBoxProvider | undefined {
  let config;
  try {
    config = readBridgeConfig();
  } catch {
    return undefined;
  }
  const seatHolderPid = opts.seatHolderPid ?? agentSeatHolderPid;

  let data: MenuStatusData = {
    agentName: config.agentName,
    claimed: config.claimUrl === undefined,
    paused: config.matchingPaused === true,
    online: seatHolderPid() !== undefined,
    dailyCap: config.autoDailyLimit,
    games: config.autoGames ?? SUPPORTED_GAMES,
    model: resolveEffectiveDeclaredModel(config).value,
  };

  // One-shot, never-throwing remote enrichment. Both arms carry their own
  // ~1.5s timeouts and already degrade instead of throwing; the catch is a
  // belt-and-braces guard so the chooser's repaint hook can never reject.
  let settled = false;
  const remote: Promise<void> = Promise.all([
    checkPlatformAgentStatus(config, opts.fetchImpl),
    checkBridgeUpdate({ baseUrl: config.baseUrl, currentVersion: RUNTIME_VERSION, fetchImpl: opts.fetchImpl }),
  ])
    .then(([status, update]) => {
      if (status.kind === "ok") {
        data = {
          ...data,
          claimed: status.isClaimed,
          agentName: status.name ?? data.agentName,
        };
      }
      if (
        (update.status === "update_recommended" || update.status === "unsupported") &&
        update.latestVersion !== undefined
      ) {
        data = { ...data, updateVersion: update.latestVersion };
      }
    })
    .catch(() => undefined)
    .then(() => {
      settled = true;
    });

  return {
    title: `AIFight · v${RUNTIME_VERSION}`,
    lines: () => composeMenuStatusLines(data),
    refreshed: () => (settled ? undefined : remote),
  };
}
