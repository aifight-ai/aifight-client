// D6 / D6.5 — the cockpit: the desktop's unique value. A REAL bridge match drives
// the board + reasoning live via IPC (window.aifight.onServerMessage, folded by
// liveMatch.ts; onTrace for reasoning). Offline, it plays a fixture as a replay
// with a synthesized trace stream, so the value is demoable without being online.
//
// This view only SELECTS the source (live match vs demo fixture) and the header
// chrome; the board + strip + reasoning + transport live in CockpitPanel, shared
// with the History replay so a past match looks exactly like a live one.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";

import { FIXTURES, FIXTURE_GAMES } from "../fixtures";
import { synthesizeTraces } from "../demoMatch";
import { type MatchOutcome } from "../liveMatch";
import { useLiveStore } from "../liveStore";
import { useBridgeStatus } from "../useBridge";
import { gameLabel } from "../../shared/games";
import { CockpitPanel } from "./CockpitPanel";

/** Build the replay origin from the bridge's configured base URL (ws→http). */
function replayOrigin(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return "https://aifight.ai";
  try {
    const u = new URL(baseUrl);
    const proto = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
    return `${proto}//${u.host}`;
  } catch {
    return "https://aifight.ai";
  }
}

function outcomeText(t: (k: string) => string, outcome: MatchOutcome): string | null {
  if (outcome === "win") return t("cockpit.outcomeWin");
  if (outcome === "loss") return t("cockpit.outcomeLoss");
  if (outcome === "draw") return t("cockpit.outcomeDraw");
  return null;
}

export function WatchView() {
  const { t } = useTranslation();
  const status = useBridgeStatus();
  // Live match + reasoning come from the always-on store (liveStore.ts), so a
  // match that began while the user was on another view shows here from frame 1.
  const live = useLiveStore();
  const liveMatch = live.match;
  const liveTraces = live.traces;
  const [demoGame, setDemoGame] = useState<(typeof FIXTURE_GAMES)[number]>("texas_holdem");

  const isLive = liveMatch.sessionId !== null && liveMatch.match !== null;

  const demoFix = FIXTURES[demoGame];
  const match = isLive ? liveMatch.match! : demoFix.match;
  const events = isLive ? liveMatch.events : demoFix.events;
  const ownerPlayerId = isLive ? liveMatch.ownerPlayerId ?? "" : demoFix.ownerPlayerId;
  const ownerPrivate = isLive ? liveMatch.ownerPrivate : demoFix.ownerPrivate;
  const boardGame = isLive ? liveMatch.game ?? demoGame : demoGame;

  const hasLiveTraces = liveTraces.length > 0;
  const traces = hasLiveTraces
    ? liveTraces
    : isLive
      ? []
      : synthesizeTraces(match, events, ownerPlayerId);
  const badge: "live" | "demo" = hasLiveTraces || isLive ? "live" : "demo";

  const outcome = outcomeText(t, liveMatch.outcome);
  const replayHref =
    liveMatch.replayPath !== null ? replayOrigin(status?.config?.baseUrl) + liveMatch.replayPath : null;

  const headerLeft = isLive ? (
    <div className="flex items-center gap-2.5">
      <span className="text-[13px] font-medium text-[var(--text)]">{gameLabel(boardGame)}</span>
      {liveMatch.finished ? (
        <span className="rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
          {t("cockpit.finished")}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-400">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          {t("cockpit.liveMatch")}
        </span>
      )}
      {outcome !== null && <span className="text-[12px] font-medium text-[var(--accent)]">{outcome}</span>}
      {replayHref !== null && (
        <a
          href={replayHref}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ExternalLink size={13} />
          {t("cockpit.openReplay")}
        </a>
      )}
    </div>
  ) : (
    <div className="inline-flex gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
      {FIXTURE_GAMES.map((g) => (
        <button
          key={g}
          onClick={() => setDemoGame(g)}
          className={
            "rounded-md px-3 py-1.5 text-[13px] transition-colors " +
            (demoGame === g
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text)]")
          }
        >
          {gameLabel(g)}
        </button>
      ))}
      <span className="ml-1 flex items-center px-1.5 text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
        {t("cockpit.demoMatch")}
      </span>
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-3">
      {!isLive && (
        <div className="shrink-0 rounded-lg border border-[var(--accent)]/25 bg-[var(--accent-soft)] px-3.5 py-2.5 text-[12px] text-[var(--accent-text)]">
          {t("watch.demoBanner")}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CockpitPanel
          key={`${match.id}:${isLive ? "live" : "demo"}`}
          game={boardGame}
          match={match}
          events={events}
          ownerPlayerId={ownerPlayerId}
          ownerPrivate={ownerPrivate}
          traces={traces.slice()}
          isLive={isLive}
          badge={badge}
          note={isLive ? t("cockpit.liveNote") : t("cockpit.note")}
          emptyTraceHint={isLive ? t("cockpit.waitingTrace") : undefined}
          headerLeft={headerLeft}
        />
      </div>
    </div>
  );
}
