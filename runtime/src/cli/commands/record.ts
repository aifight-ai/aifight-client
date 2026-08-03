// `aifight record` — show this machine's agent public competitive record:
// ratings, rank, recent matches and achievements.
//
// Reads the SAME public, unauthenticated endpoint the website agent page uses
// (`GET /api/agents/{id}/profile`). No API key is sent — this is read-only
// public data keyed by the locally-configured agent id. Rendering goes through
// the shared styled-output kit (cli/output.ts, V4) and the i18n dicts;
// --json stays the raw profile payload, byte-stable.

import { formatPublicNo } from "../../account/public-no";
import { readBridgeConfig } from "../../bridge/config";
import { gameLabel, resolveLocale, t, type Locale } from "../i18n";
import { createOutput, type Output, type TableColumn } from "../output";
import { visibleWidth } from "../ansi";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { expectArity, CommandError } from "../shared";

const USAGE = "usage: aifight record";
const RECORD_TIMEOUT_MS = 4000;

export async function runRecord(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const loc = env.locale?.() ?? resolveLocale();

  const config = readOptionalBridgeConfig();
  if (config === undefined) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "not_configured" }) + "\n");
    } else {
      const out = createOutput();
      env.stdout(`${out.section(t(loc, "record.title"))}\n\n`);
      env.stdout(`${out.kv(t(loc, "status.label.bridge"), t(loc, "status.value.not_configured"), { tone: "yellow" })}\n`);
      env.stdout(`${out.note(t(loc, "record.next"))}\n`);
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

  env.stdout(renderRecord(profile, config.agentName, base, {
    loc,
    out: createOutput(),
    claimUrl: config.claimUrl,
    agentId: config.agentId,
  }));
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

export interface RenderRecordDeps {
  readonly loc: Locale;
  readonly out: Output;
  readonly claimUrl?: string;
  /** The local agent id — turns the header into a pointer at the public agent
   *  page (`{base}/agents/{id}`, P7: one line that says what this screen IS).
   *  Absent = the pointer is skipped. */
  readonly agentId?: string;
}

/** Exported for tests: the styled human rendering (colors/width injectable). */
export function renderRecord(profile: unknown, fallbackName: string, base: string, deps: RenderRecordDeps): string {
  const { loc, out } = deps;
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

  const idSuffix = publicNo !== undefined && publicNo > 0 ? out.ansi.dim(`  (ID ${formatPublicNo(publicNo)})`) : "";
  lines.push(`${out.section(t(loc, "record.title"))} · ${out.ansi.bold(name)}${idSuffix}`);
  if (model) lines.push(out.kv(t(loc, "record.model"), model, { tone: "cyan" }));
  // P7 (U8b): one line that says what this screen IS, then the public page it
  // mirrors — the URL plain on its own line so the terminal can link it.
  lines.push(out.note(t(loc, "record.intro")));
  if (deps.agentId !== undefined && deps.agentId !== "") {
    lines.push(`  ${base}/agents/${deps.agentId}`);
  }
  lines.push("");

  if (totalGames <= 0) {
    lines.push(t(loc, "record.empty"));
    const note = rankedStatusNote(isClaimed, 0, false, base, deps);
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

  lines.push(out.section(t(loc, "record.section.overall")));
  const ranked = globalRank !== undefined && eligible;
  lines.push(...out.kvRows([
    [t(loc, "record.rank"), ranked ? `#${globalRank}` : t(loc, "record.rank.unranked"), ranked ? "green" : "default"],
    ...(bestRating !== undefined && bestGame
      ? [[t(loc, "record.best"), `${Math.round(bestRating)} · ${gameLabel(loc, bestGame)}`, "cyan"] as const]
      : []),
    [t(loc, "record.record"), `${wins}-${losses}-${draws} ${t(loc, "record.wld")}`],
    [t(loc, "record.winrate"), pct(winRate)],
    [t(loc, "record.games"), t(loc, "record.games.value", { total: totalGames, active: gamesActive, unit: t(loc, gamesActive === 1 ? "record.games.unit.one" : "record.games.unit.many") })],
  ]));

  const note = rankedStatusNote(isClaimed, gamesNeeded, eligible, base, deps);
  if (note) {
    lines.push("");
    lines.push(note);
  }

  // ── Per game ──
  const rated = ratings.map(asObj).filter((r) => (asNum(r.games_played) ?? 0) > 0);
  if (rated.length > 0) {
    lines.push("");
    lines.push(out.section(t(loc, "record.section.pergame")));
    const columns: TableColumn[] = [
      { label: t(loc, "record.col.game") },
      { label: t(loc, "record.col.rating"), align: "right", tone: "cyan" },
      { label: t(loc, "record.col.games"), align: "right" },
      { label: t(loc, "record.col.wld"), align: "right" },
      { label: t(loc, "record.col.winpct"), align: "right" },
    ];
    const rows = rated.map((r) => {
      const rating = asNum(r.display_rating) ?? asNum(r.rating) ?? 0;
      return [
        gameLabel(loc, asStr(r.game) ?? "-"),
        String(Math.round(rating)),
        String(asNum(r.games_played) ?? 0),
        `${asNum(r.wins) ?? 0}-${asNum(r.losses) ?? 0}-${asNum(r.draws) ?? 0}`,
        pct(asNum(r.win_rate) ?? 0),
      ];
    });
    lines.push(...out.table(columns, rows));
  }

  // ── Recent matches ──
  const recentRows = recent.map(asObj).slice(0, 5);
  if (recentRows.length > 0) {
    lines.push("");
    lines.push(out.section(t(loc, "record.section.recent")));
    const gamesCol = recentRows.map((m) => gameLabel(loc, asStr(m.game) ?? "-"));
    const resultsCol = recentRows.map((m) => asStr(m.agent_result) ?? "-");
    const gameW = Math.max(visibleWidth(t(loc, "record.col.game")), ...gamesCol.map(visibleWidth));
    const resultW = Math.max(visibleWidth(t(loc, "record.col.result")), ...resultsCol.map(visibleWidth));
    // The 2026-07 glued-column bug: the opponents list used to be padded (never
    // truncated), so a long one swallowed the gap and the date glued onto the
    // last name. The opponents column now truncates with an ellipsis to a
    // terminal-aware budget and the date always keeps its own column.
    const termWidth = (process.stdout.columns ?? 0) > 0 ? process.stdout.columns! : 80;
    const fixed = 2 /* indent */ + gameW + 2 + resultW + 2 + 10 /* date */ + 2;
    const oppsMax = Math.max(20, termWidth - fixed);
    const columns: TableColumn[] = [
      { label: t(loc, "record.col.game"), minWidth: gameW },
      { label: t(loc, "record.col.result"), minWidth: resultW },
      { label: t(loc, "record.col.opponents"), maxWidth: oppsMax },
      { label: t(loc, "record.col.date"), minWidth: 10 },
    ];
    const rows = recentRows.map((m, i) => {
      const opps = asArr(m.opponent_names).map((o) => asStr(o) ?? "").filter(Boolean);
      return [
        gamesCol[i]!,
        resultsCol[i]!,
        opps.length > 0 ? `vs ${opps.join(", ")}` : "",
        (asStr(m.finished_at) ?? "").slice(0, 10),
      ];
    });
    // U8b: every row gets its replay link underneath. `id` is the encrypted
    // public_replay_id the website's agent page links with (`/replay/{id}`) —
    // the CLI has always had it in the payload and never shown it. Plain and
    // on its own line so terminals turn it into something clickable.
    const replayIds = recentRows.map((m) => asStr(m.id));
    const table = out.table(columns, rows);
    lines.push(table[0]!);
    table.slice(1).forEach((row, i) => {
      lines.push(row);
      const id = replayIds[i];
      if (id !== undefined) lines.push(`    ${base}/replay/${id}`);
    });
    if (replayIds.some((id) => id !== undefined)) {
      lines.push(out.note(t(loc, "record.recent.replay")));
    }
  }

  // ── Achievements ──
  if (achievements.length > 0) {
    lines.push("");
    lines.push(`${out.section(t(loc, "record.section.achievements"))}  ${out.ansi.dim(t(loc, "record.achievements.unlocked", { count: achievements.length }))}`);
    const shown = achievements.map(asObj).slice(0, 6);
    for (const a of shown) {
      const title = asStr(a.title) ?? "—";
      const tier = asStr(a.tier) ?? "common";
      lines.push(`  · ${title} ${out.ansi.dim(`— ${tier}`)}`);
    }
    if (achievements.length > shown.length) {
      lines.push(out.note(t(loc, "record.achievements.more", { count: achievements.length - shown.length })));
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
  deps: RenderRecordDeps,
): string | undefined {
  const { loc, out } = deps;
  // The "Note: " lead-in is translated too (it used to be hardcoded English in
  // front of a Chinese sentence).
  const prefix = t(loc, "record.note.prefix");
  if (!isClaimed) {
    // Point at the REAL claim link when it is still on file locally — sending
    // the user to the dashboard without the link is a dead end.
    if (deps.claimUrl !== undefined) {
      return `${out.note(`${prefix}${t(loc, "record.note.unclaimed_link")}`)}\n  ${deps.claimUrl}`;
    }
    return out.note(`${prefix}${t(loc, "record.note.unclaimed", { url: `${base}/dashboard` })}`);
  }
  if (!eligible && gamesNeeded > 0) {
    return out.note(`${prefix}${t(loc, "record.note.qualify", { count: gamesNeeded, match: t(loc, gamesNeeded === 1 ? "record.note.match.one" : "record.note.match.many") })}`);
  }
  return undefined;
}

// ── Tiny helpers (no shared dependency) ──

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

