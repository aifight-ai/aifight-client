// `aifight record` — show this machine's agent public competitive record:
// ratings, rank, recent matches and achievements.
//
// Reads the SAME public, unauthenticated endpoint the website agent page uses
// (`GET /api/agents/{id}/profile`). No API key is sent — this is read-only
// public data keyed by the locally-configured agent id. Output mirrors the
// `status` command's plain key:value house style (no colour libraries).

import { formatPublicNo } from "../../account/public-no";
import { readBridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { expectArity, CommandError } from "../shared";

const USAGE = "usage: aifight record";
const RECORD_TIMEOUT_MS = 4000;

const GAME_LABELS: Readonly<Record<string, string>> = {
  texas_holdem: "Texas Hold'em",
  liars_dice: "Liar's Dice",
  coup: "Coup",
};
function gameLabel(game: string): string {
  return GAME_LABELS[game] ?? game;
}

export async function runRecord(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, USAGE);

  const config = readOptionalBridgeConfig();
  if (config === undefined) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "not_configured" }) + "\n");
    } else {
      env.stdout("AIFight record\n\n");
      env.stdout("Bridge: not configured\n");
      env.stdout("Next: run `aifight setup` to create your agent, then play a few matches.\n");
    }
    return 0;
  }

  const fetchImpl = env.fetchImpl ?? globalThis.fetch;
  const base = config.baseUrl.replace(/\/+$/, "");
  const url = `${base}/api/agents/${encodeURIComponent(config.agentId)}/profile`;

  const profile = await fetchProfile(url, fetchImpl);

  if (args.jsonMode) {
    env.stdout(JSON.stringify(profile) + "\n");
    return 0;
  }

  env.stdout(renderRecord(profile, config.agentName, base));
  return 0;
}

async function fetchProfile(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECORD_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (res.status === 404) {
      throw new CommandError(
        "agent_not_found",
        "This agent was not found on AIFight (it may not be registered yet).",
        { hint: "Run `aifight status` to check your local setup, or `aifight setup` to register." },
      );
    }
    if (!res.ok) {
      throw new CommandError("server_error", `AIFight returned HTTP ${res.status}.`);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof CommandError) throw e;
    const name = (e as { name?: string } | null)?.name;
    throw new CommandError(
      "unreachable",
      name === "AbortError"
        ? "AIFight did not respond in time. Check your connection and try again."
        : "Could not reach AIFight. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── Rendering ────────────────────────────────────────────────────────

function renderRecord(profile: unknown, fallbackName: string, base: string): string {
  const root = asObj(profile);
  const agent = asObj(root.agent);
  const summary = asObj(root.summary);
  const ratings = asArr(root.ratings);
  const recent = asArr(root.recent_matches);
  const achievements = asArr(root.achievements);

  const name = asStr(agent.name) ?? fallbackName;
  const model = asStr(agent.model);
  const publicNo = asNum(agent.public_no);
  const isClaimed = asBool(agent.is_claimed) ?? false;

  const totalGames = asNum(summary.total_games) ?? sumRatings(ratings, "games_played");
  const lines: string[] = [];

  const idLabel = publicNo !== undefined && publicNo > 0 ? `  (ID ${formatPublicNo(publicNo)})` : "";
  lines.push(`AIFight record · ${name}${idLabel}`);
  if (model) lines.push(`Model: ${model}`);
  lines.push("");

  if (totalGames <= 0) {
    lines.push("No ranked matches yet — play a few, then check back.");
    const note = rankedStatusNote(isClaimed, 0, false, base);
    if (note) {
      lines.push("");
      lines.push(note);
    }
    return lines.join("\n") + "\n";
  }

  // ── Overall ──
  const globalRank = asNum(summary.global_rank);
  const eligible = asBool(summary.leaderboard_eligible) ?? false;
  const gamesNeeded = asNum(summary.leaderboard_games_needed) ?? 0;
  const wins = asNum(summary.total_wins) ?? sumRatings(ratings, "wins");
  const losses = asNum(summary.total_losses) ?? sumRatings(ratings, "losses");
  const draws = asNum(summary.total_draws) ?? sumRatings(ratings, "draws");
  const winRate = asNum(summary.overall_win_rate) ?? 0;
  const gamesActive = asNum(summary.games_active) ?? ratings.length;
  const bestRating = asNum(summary.best_display_rating);
  const bestGame = asStr(summary.best_game);

  lines.push("Overall");
  lines.push(`  ${padRight("Rank", 14)}${globalRank !== undefined && eligible ? `#${globalRank}` : "not yet ranked"}`);
  if (bestRating !== undefined && bestGame) {
    lines.push(`  ${padRight("Best rating", 14)}${Math.round(bestRating)} · ${gameLabel(bestGame)}`);
  }
  lines.push(`  ${padRight("Record", 14)}${wins}-${losses}-${draws} (W-L-D)`);
  lines.push(`  ${padRight("Win rate", 14)}${pct(winRate)}`);
  lines.push(`  ${padRight("Games", 14)}${totalGames} across ${gamesActive} game${gamesActive === 1 ? "" : "s"}`);

  const note = rankedStatusNote(isClaimed, gamesNeeded, eligible, base);
  if (note) {
    lines.push("");
    lines.push(note);
  }

  // ── Per game ──
  const rated = ratings.map(asObj).filter((r) => (asNum(r.games_played) ?? 0) > 0);
  if (rated.length > 0) {
    lines.push("");
    lines.push("Per game");
    lines.push(renderPerGameTable(rated));
  }

  // ── Recent matches ──
  const recentRows = recent.map(asObj).slice(0, 5);
  if (recentRows.length > 0) {
    lines.push("");
    lines.push("Recent matches");
    for (const m of recentRows) {
      const g = padRight(gameLabel(asStr(m.game) ?? "-"), 14);
      const result = padRight(asStr(m.agent_result) ?? "-", 5);
      const opps = asArr(m.opponent_names).map((o) => asStr(o) ?? "").filter(Boolean);
      const vs = opps.length > 0 ? `vs ${opps.join(", ")}` : "";
      const when = (asStr(m.finished_at) ?? "").slice(0, 10);
      lines.push(`  ${g}${result} ${padRight(vs, 28)}${when}`.trimEnd());
    }
  }

  // ── Achievements ──
  if (achievements.length > 0) {
    lines.push("");
    lines.push(`Achievements  ${achievements.length} unlocked`);
    const shown = achievements.map(asObj).slice(0, 6);
    for (const a of shown) {
      const title = asStr(a.title) ?? "—";
      const tier = asStr(a.tier) ?? "common";
      lines.push(`  · ${title} — ${tier}`);
    }
    if (achievements.length > shown.length) {
      lines.push(`  … and ${achievements.length - shown.length} more`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * The actionable one-liner that explains WHY an agent is not on the
 * leaderboard yet. Mirrors the desktop ranked-progress hint:
 *   - not claimed  → can't play ranked until the owner verifies email (claim)
 *   - games needed → N more matches to qualify
 *   - eligible     → no note (rank is shown above)
 *
 * Claim is the only gate now (owner ruling 2026-06-18); a display name is a
 * free-form label and is never required to play.
 */
function rankedStatusNote(
  isClaimed: boolean,
  gamesNeeded: number,
  eligible: boolean,
  base: string,
): string | undefined {
  if (!isClaimed) {
    return `Note: this agent isn't claimed yet — open its claim link to verify your email (${base}/dashboard) before it can play ranked.`;
  }
  if (!eligible && gamesNeeded > 0) {
    return `Note: ${gamesNeeded} more ranked match${gamesNeeded === 1 ? "" : "es"} in one game to qualify for the leaderboard.`;
  }
  return undefined;
}

function renderPerGameTable(rated: ReadonlyArray<Record<string, unknown>>): string {
  const headers = ["GAME", "RATING", "GAMES", "W-L-D", "WIN%"];
  const rows: string[][] = rated.map((r) => {
    const rating = asNum(r.display_rating) ?? asNum(r.rating) ?? 0;
    const wld = `${asNum(r.wins) ?? 0}-${asNum(r.losses) ?? 0}-${asNum(r.draws) ?? 0}`;
    return [
      gameLabel(asStr(r.game) ?? "-"),
      String(Math.round(rating)),
      String(asNum(r.games_played) ?? 0),
      wld,
      pct(asNum(r.win_rate) ?? 0),
    ];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const fmt = (cells: string[]) => "  " + cells.map((c, i) => padRight(c, widths[i]!)).join("  ");
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

// ── Tiny helpers (no shared dependency; format.ts's padRight is private) ──

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function sumRatings(ratings: readonly unknown[], field: string): number {
  return ratings.reduce<number>((acc, r) => acc + (asNum(asObj(r)[field]) ?? 0), 0);
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function readOptionalBridgeConfig(): ReturnType<typeof readBridgeConfig> | undefined {
  try {
    return readBridgeConfig();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("bridge is not configured")) return undefined;
    throw cause;
  }
}
