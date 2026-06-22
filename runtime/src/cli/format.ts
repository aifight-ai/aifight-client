// Formatting helpers for CLI human-mode output.
//
// All functions return a single string ready to write to stdout (caller
// adds trailing newline if needed). JSON-mode emission is the caller's
// responsibility (handlers JSON.stringify the server response themselves).
//
// Internal-only — not re-exported.

/** Minimal duck-type of M1-16 SanitizedAgentSnapshot we render. */
interface AgentSnapshotLike {
  readonly name: string;
  readonly started: boolean;
  readonly stopped: boolean;
  readonly transport?: string;
  readonly state: AgentStateLike | null;
}

interface AgentStateLike {
  readonly phase?: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly availableGames?: readonly string[];
  readonly autoConfirmMatches?: boolean;
  readonly queue?: { readonly game: string; readonly mode: string };
  readonly activeMatch?: {
    readonly sessionId: string;
    readonly game: string;
    readonly startedAt: number;
  };
  readonly activeMatches?: Readonly<Record<string, {
    readonly sessionId: string;
    readonly game: string;
    readonly startedAt: number;
  }>>;
  readonly activeMatchCount?: number;
}

interface DailyScheduleConfigLike {
  readonly enabled: boolean;
  readonly timezone: string;
  readonly minIntervalSec?: number;
  readonly days: Readonly<Record<string, { readonly count: number }>>;
}

/** Pad a string on the right to `width` ASCII characters (no double-width
 *  awareness — agent names / phases are ASCII in practice). */
function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

export function formatAgentTable(agents: readonly AgentSnapshotLike[]): string {
  if (agents.length === 0) {
    return "(no agents)\n";
  }
  const headers = ["NAME", "PHASE", "TRANSPORT", "STARTED"];
  const rows: string[][] = agents.map((a) => [
    a.name,
    a.state?.phase ?? "-",
    a.transport ?? "-",
    a.started ? (a.stopped ? "stopped" : "yes") : "no",
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const lines: string[] = [];
  lines.push(headers.map((h, i) => padRight(h, widths[i]!)).join("  "));
  for (const r of rows) {
    lines.push(r.map((c, i) => padRight(c, widths[i]!)).join("  "));
  }
  return lines.join("\n") + "\n";
}

export function formatAgentStatus(agent: AgentSnapshotLike): string {
  const lines: string[] = [];
  lines.push(`name             : ${agent.name}`);
  lines.push(`started          : ${agent.started ? "yes" : "no"}`);
  lines.push(`stopped          : ${agent.stopped ? "yes" : "no"}`);
  lines.push(`transport        : ${agent.transport ?? "-"}`);
  if (agent.state === null) {
    lines.push(`phase            : (not connected)`);
  } else {
    lines.push(`phase            : ${agent.state.phase ?? "-"}`);
    if (agent.state.agentId !== undefined) lines.push(`agent id         : ${agent.state.agentId}`);
    if (agent.state.availableGames !== undefined) {
      lines.push(`available games  : ${agent.state.availableGames.join(", ") || "(none)"}`);
    }
    if (agent.state.queue !== undefined) {
      lines.push(`queue            : ${agent.state.queue.game} (${agent.state.queue.mode})`);
    }
    const activeMatches = agent.state.activeMatches ? Object.values(agent.state.activeMatches) : [];
    if (activeMatches.length > 1) {
      lines.push(`active matches   : ${activeMatches.length}`);
      for (const match of activeMatches) {
        lines.push(`  - ${match.sessionId} (${match.game})`);
      }
    } else if (agent.state.activeMatch !== undefined) {
      lines.push(`active match     : ${agent.state.activeMatch.sessionId} (${agent.state.activeMatch.game})`);
    }
  }
  return lines.join("\n") + "\n";
}

interface ScheduleSnapshotLike {
  readonly running: boolean;
  /** YYYY-MM-DD local date (M1-15 DailySchedulerSnapshot.today) or null
   *  when scheduler has not yet computed the boundary. */
  readonly today?: string | null;
  readonly remaining?: Readonly<Record<string, number>>;
  readonly nextFireInMs?: number | null;
  readonly lastAttempt?: {
    readonly outcome?: string;
    readonly game?: string | null;
    readonly atMs?: number;
  } | null;
}

export function formatScheduleShow(
  cfg: DailyScheduleConfigLike | null,
  snap: ScheduleSnapshotLike,
): string {
  const lines: string[] = [];
  lines.push("schedule:");
  if (cfg === null) {
    lines.push("  (no schedule configured — use `aifight daily set <game> <count>`)");
  } else {
    lines.push(`  enabled        : ${cfg.enabled ? "yes" : "no"}`);
    lines.push(`  timezone       : ${cfg.timezone}`);
    if (cfg.minIntervalSec !== undefined) {
      lines.push(`  min interval s : ${cfg.minIntervalSec}`);
    }
    const games = Object.keys(cfg.days);
    if (games.length === 0) {
      lines.push(`  per-game quota : (none)`);
    } else {
      lines.push(`  per-game quota :`);
      for (const g of games.sort()) {
        const entry = cfg.days[g]!;
        lines.push(`    ${padRight(g, 14)} count=${entry.count}`);
      }
    }
  }
  lines.push("");
  lines.push("snapshot:");
  lines.push(`  running        : ${snap.running ? "yes" : "no"}`);
  if (snap.nextFireInMs !== undefined && snap.nextFireInMs !== null) {
    lines.push(`  next fire in   : ${snap.nextFireInMs} ms`);
  }
  if (typeof snap.today === "string" && snap.today.length > 0) {
    lines.push(`  today date     : ${snap.today}`);
  }
  const remaining = snap.remaining;
  if (remaining !== undefined) {
    const games = Object.keys(remaining).sort();
    if (games.length > 0) {
      lines.push(`  today remaining:`);
      for (const g of games) {
        lines.push(`    ${padRight(g, 14)} ${remaining[g]}`);
      }
    }
  }
  if (snap.lastAttempt != null && snap.lastAttempt.outcome !== undefined) {
    const la = snap.lastAttempt;
    const game = la.game ?? "-";
    lines.push(`  last attempt   : outcome=${la.outcome} game=${game}`);
  }
  return lines.join("\n") + "\n";
}

/** Compose a JSON-mode error envelope. Used by main.ts error funnel and
 *  by handlers that surface a usage error in JSON mode. */
export function jsonErrorEnvelope(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): string {
  const body: { error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } } =
    details === undefined
      ? { error: { code, message } }
      : { error: { code, message, details } };
  return JSON.stringify(body) + "\n";
}
