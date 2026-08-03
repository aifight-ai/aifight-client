// The boxed status banner at the top of the interactive panel (owner ask
// 2026-07-30, 3x-ui style: "the top could show agent status").
//
// V2 (2026-07-31, owner decision ③): the box is a fixed THREE lines —
//   1. identity (name · claim · presence · daily cap),
//   2. MATCHING STATE (paused / claim-first / queued / idle / bridge down),
//   3. model · update nudge · games.
// The middle line is always exactly one line, so a refresh repaint never
// changes the rendered line count. Its queue truth comes from the running
// bridge's control API (GET /v1/agents → state.queue); when no bridge is
// running the line says so honestly instead of guessing.
//
// Data policy:
//   * LOCAL bridge.json + local process probes are always enough to draw the
//     box — the panel never waits on the network for its first paint.
//   * REMOTE facts (authoritative claim state, server-side name, update
//     check, the live queue) are best-effort: fetched ONCE per panel session
//     with the same ~1.5s budgets `aifight status` uses, in parallel with the
//     first render. When the answers land the chooser repaints the box; when
//     they don't (offline, slow), the local-only box simply stays — no error
//     noise.
//   * "Matches used today" rides the SAME remote arm (U5/T4, 2026-08-02):
//     `/api/agents/me/status` already answers with `games_today`, it was
//     simply parsed away. So the daily wording is the cap alone on the first
//     paint ("auto 5/day") and becomes "auto 2/5/day" once that answer lands.
//     The cap in it stays the LOCAL one — a local cap of 0 is stored
//     server-side as auto_requeue:false, leaving the platform's own
//     max_games_per_day at its previous value.
//
// Everything here is injectable/pure except createMenuStatusBox's one config
// read, so banner composition is unit-testable without a terminal or network.

import { checkPlatformAgentStatus } from "../../account/platform-agent-status.js";
import { readBridgeConfig } from "../../bridge/config.js";
import { resolveEffectiveDeclaredModel } from "../../bridge/declared-model.js";
import { checkBridgeUpdate } from "../../bridge/update-check.js";
import { RUNTIME_VERSION } from "../../index.js";
import { createControlClient } from "../control-client.js";
import { joinGameLabels, t, type Locale } from "../i18n.js";
import { readPort, readToken } from "../runtime-files.js";
import { SUPPORTED_GAMES } from "../shared.js";
import { agentSeatHolderPid } from "./bridge-start.js";
import type { MenuStatusLine, MenuStatusSegment } from "./menu-frame.js";

/** What the banner's matching line can truthfully say about the queue. */
export type MenuQueueState =
  /** The running bridge reports at least one queued entry (control API). */
  | { readonly state: "queued"; readonly games: readonly string[] }
  /** U8a: nothing queued, but the bridge is declared to the platform and
   *  waiting for it to assign a game — the state between queued and idle
   *  (this is what a default bridge does all day; it no longer queues itself
   *  into a random game). */
  | { readonly state: "standby"; readonly games: readonly string[] }
  /** The control API answered and nothing is queued. */
  | { readonly state: "idle" }
  /** A bridge seat exists but the control API did not answer — config truth
   *  only, no queue claim (also the desktop seat, which speaks no control
   *  API, and the first paint while the probe is still in flight). */
  | { readonly state: "unknown" }
  /** No live bridge seat on this machine. */
  | { readonly state: "not_running" };

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
  /** Automatic matches the PLATFORM counted today (`games_today`). Known only
   *  after the one-shot remote refresh lands; until then the daily wording is
   *  the cap alone, never a guessed "0". */
  readonly dailyUsed?: number;
  readonly games: readonly string[];
  /** The effective declared model (what the leaderboard shows). */
  readonly model: string;
  /** Set when the update check found a newer CLI — the yellow hint. */
  readonly updateVersion?: string;
  /** The queue truth behind the banner's matching line. */
  readonly matching: MenuQueueState;
}

export interface MenuStatusBoxProvider {
  /** The box border title, e.g. "AIFight · v0.1.0-beta.39". */
  readonly title: string;
  /** Current banner lines — local-only until the one-shot remote refresh
   *  resolves, enriched afterwards. Always the same number of lines, so a
   *  refresh repaint never changes the rendered line count. Takes the locale
   *  per call so the panel's Language toggle re-renders the same data in the
   *  new language (default "en"). */
  lines(loc?: Locale): readonly MenuStatusLine[];
  /** The one-shot remote refresh while it is still pending; undefined once
   *  settled (or when there was nothing to fetch). Never rejects. */
  refreshed(): Promise<unknown> | undefined;
  /** The newer CLI version once the update check landed (undefined before
   *  that, when current, or when the check never answered). The menu's
   *  Update item reads it for its yellow hint. */
  updateVersion?(): string | undefined;
}

/** The daily-cap wording shared by line 1 and the matching line. With the
 *  platform's own count in hand (after the remote refresh) it becomes
 *  "auto 2/5/day"; without it, or with nothing automatic running at all, the
 *  three cap-only wordings stand unchanged. */
function dailyText(loc: Locale, dailyCap: number | undefined, dailyUsed?: number): string {
  if (dailyCap === undefined) return t(loc, "banner.daily.unset");
  if (dailyCap === 0) return t(loc, "banner.daily.off");
  if (dailyUsed !== undefined) return t(loc, "banner.daily.used", { used: dailyUsed, cap: dailyCap });
  return t(loc, "banner.daily.cap", { cap: dailyCap });
}

/**
 * The banner's middle line — the matching state (V2, owner decision ③).
 * Always exactly ONE line whatever the inputs, so a refresh repaint never
 * shifts the rows below. Priority: paused beats everything (a paused bridge
 * may still be connected, and "I thought I was queued" is the confusion the
 * pause feature exists to kill); unclaimed guidance next (the agent cannot
 * play at all until then); only then the queue truth.
 */
function composeMatchingLine(data: MenuStatusData, loc: Locale): MenuStatusLine {
  if (data.paused) {
    return [{ text: t(loc, "banner.match.paused"), style: "yellow" }];
  }
  if (!data.claimed) {
    return [{ text: t(loc, "banner.match.unclaimed"), style: "yellow" }];
  }
  const daily = dailyText(loc, data.dailyCap, data.dailyUsed);
  switch (data.matching.state) {
    case "queued":
      return [{ text: t(loc, "banner.match.queued", { games: joinGameLabels(loc, data.matching.games) }), style: "cyan" }];
    case "standby":
      // Cyan like queued: standing by is an ACTIVE state (the platform can
      // assign a match any moment), not the dim "nothing is happening" of idle.
      return [{ text: t(loc, "banner.match.standby"), style: "cyan" }];
    case "idle":
      return [{ text: t(loc, "banner.match.idle", { daily }), style: "dim" }];
    case "unknown":
      // The control API did not answer — say only what the config proves.
      return [{ text: t(loc, "banner.match.unknown", { daily }), style: "dim" }];
    case "not_running":
      return [{ text: t(loc, "banner.match.not_running", { daily }), style: "dim" }];
  }
}

/** Pure line composition — exported so tests assert the exact segments. */
export function composeMenuStatusLines(data: MenuStatusData, loc: Locale = "en"): readonly MenuStatusLine[] {
  const claim: MenuStatusSegment = data.claimed
    ? { text: t(loc, "banner.claimed"), style: "green" }
    : { text: t(loc, "banner.unclaimed"), style: "yellow" };
  // Paused wins over online: a paused bridge can be connected yet is NOT
  // matching, and that is the state the user must not miss (a paused agent
  // looks "online" everywhere else — the confusion pause was added to fix).
  const presence: MenuStatusSegment = data.paused
    ? { text: t(loc, "banner.paused"), style: "yellow" }
    : data.online
      ? { text: t(loc, "banner.online"), style: "green" }
      : { text: t(loc, "banner.offline"), style: "dim" };
  const line1: MenuStatusLine = [
    { text: data.agentName, style: "bold" },
    { text: " · " },
    claim,
    { text: " · " },
    presence,
    { text: " · " },
    { text: dailyText(loc, data.dailyCap, data.dailyUsed), style: "dim" },
  ];
  const line3: MenuStatusSegment[] = [
    { text: data.model, style: "cyan" },
  ];
  // The update hint goes BEFORE the games list: when the line must truncate,
  // the games tail (fully visible via item 7 / `aifight status`) is what
  // shortens, never the version itself.
  if (data.updateVersion !== undefined) {
    line3.push({ text: " · " }, { text: t(loc, "banner.update", { version: data.updateVersion }), style: "yellow" });
  }
  line3.push(
    { text: t(loc, "banner.games.sep"), style: "dim" },
    { text: joinGameLabels(loc, data.games) },
  );
  return [line1, composeMatchingLine(data, loc), line3];
}

export interface CreateMenuStatusBoxOptions {
  readonly fetchImpl?: typeof fetch;
  /** Test seam for the local online probe. Default: agentSeatHolderPid. */
  readonly seatHolderPid?: () => number | undefined;
  /** Test seam for the live-queue probe (the running bridge's control API).
   *  Only consulted when a bridge seat exists. Default: probeQueueState. */
  readonly queueProbe?: () => Promise<MenuQueueState>;
}

/** The queue probe's budget — the same ~1.5s the other one-shot arms get. */
const QUEUE_PROBE_TIMEOUT_MS = 1500;

/**
 * Ask the running bridge's control API what it is queued for, or standing by
 * for (GET /v1/agents → state.queue.game / state.standby.games — the same
 * shape `aifight update`'s match guard reads). A real queue entry wins: it is
 * a concrete commitment, standby is an availability declaration, and an agent
 * can hold both (the legacy self-join posture). Any failure — no daemon files,
 * a desktop seat (no control API), a timeout — maps to "unknown": the banner
 * then shows config truth only and never invents a matching state.
 */
async function probeQueueState(fetchImpl: typeof fetch | undefined): Promise<MenuQueueState> {
  try {
    const client = createControlClient({
      tokenSource: readToken,
      portSource: readPort,
      baseTimeoutMs: QUEUE_PROBE_TIMEOUT_MS,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
    const body = await client.get<{
      readonly agents?: ReadonlyArray<{
        readonly state?: {
          readonly queue?: { readonly game?: unknown } | null;
          readonly standby?: { readonly games?: unknown } | null;
        } | null;
      }>;
    }>("/v1/agents");
    const games: string[] = [];
    const standby: string[] = [];
    for (const agent of body.agents ?? []) {
      const game = agent?.state?.queue?.game;
      if (typeof game === "string" && game !== "" && !games.includes(game)) games.push(game);
      const declared = agent?.state?.standby?.games;
      if (Array.isArray(declared)) {
        for (const g of declared) {
          if (typeof g === "string" && g !== "" && !standby.includes(g)) standby.push(g);
        }
      }
    }
    if (games.length > 0) return { state: "queued", games };
    if (standby.length > 0) return { state: "standby", games: standby };
    return { state: "idle" };
  } catch {
    return { state: "unknown" };
  }
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
  const seat = seatHolderPid() !== undefined;
  const queueProbe = opts.queueProbe ?? (() => probeQueueState(opts.fetchImpl));

  let data: MenuStatusData = {
    agentName: config.agentName,
    claimed: config.claimUrl === undefined,
    paused: config.matchingPaused === true,
    online: seat,
    dailyCap: config.autoDailyLimit,
    games: config.autoGames ?? SUPPORTED_GAMES,
    model: resolveEffectiveDeclaredModel(config).value,
    // A live seat is worth asking about the queue; without one the answer is
    // known locally — no bridge, no queue.
    matching: seat ? { state: "unknown" } : { state: "not_running" },
  };

  // One-shot, never-throwing remote enrichment. All arms carry their own
  // timeouts and already degrade instead of throwing; the catch is a
  // belt-and-braces guard so the chooser's repaint hook can never reject.
  // The queue probe joins the same one-shot flight (paused makes it moot —
  // the paused line wins — but the answer is free and the probe is cheap).
  let settled = false;
  const remote: Promise<void> = Promise.all([
    checkPlatformAgentStatus(config, opts.fetchImpl),
    checkBridgeUpdate({ baseUrl: config.baseUrl, currentVersion: RUNTIME_VERSION, fetchImpl: opts.fetchImpl }),
    seat ? queueProbe() : Promise.resolve(undefined),
  ])
    .then(([status, update, queue]) => {
      if (status.kind === "ok") {
        data = {
          ...data,
          claimed: status.isClaimed,
          agentName: status.name ?? data.agentName,
          // Only when the server actually said so: an absent count must keep
          // the cap-only wording rather than claim "0 played today".
          ...(status.gamesToday !== undefined ? { dailyUsed: status.gamesToday } : {}),
        };
      }
      if (
        (update.status === "update_recommended" || update.status === "unsupported") &&
        update.latestVersion !== undefined
      ) {
        data = { ...data, updateVersion: update.latestVersion };
      }
      if (queue !== undefined) {
        data = { ...data, matching: queue };
      }
    })
    .catch(() => undefined)
    .then(() => {
      settled = true;
    });

  return {
    title: `AIFight · v${RUNTIME_VERSION}`,
    lines: (loc: Locale = "en") => composeMenuStatusLines(data, loc),
    refreshed: () => (settled ? undefined : remote),
    updateVersion: () => data.updateVersion,
  };
}
