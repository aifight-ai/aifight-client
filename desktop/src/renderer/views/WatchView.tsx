// D6 / D6.5 — the cockpit: the desktop's unique value. A REAL bridge match drives
// the board + reasoning live via IPC (window.aifight.onServerMessage, folded by
// liveMatch.ts; onTrace for reasoning). Offline, it plays a fixture as a replay
// with a synthesized trace stream, so the value is demoable without being online.
//
// This view only SELECTS the source (dashboard replay intent > live match >
// demo fixture) and the header chrome; the board + strip + reasoning +
// transport live in CockpitPanel, shared with the History replay so a past
// match looks exactly like a live one.
//
// Replay intent (owner ruling, 2026-07-02): a click on the dashboard's recent
// matches lands HERE with that session pre-loaded as a replay — parked at the
// first frame, playback only on the user's explicit ▶. Closing it falls back
// to live/demo. 🔒 Replays inherit the cockpit's information hiding
// (sessionReplay folds only the frames this agent ever received).

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, X } from "lucide-react";

import { FIXTURES, FIXTURE_GAMES } from "../fixtures";
import { synthesizeTraces } from "../demoMatch";
import { emptyLiveMatch, type MatchOutcome } from "../liveMatch";
import { useLiveStore } from "../liveStore";
import { cliRun, useBridgeStatus } from "../useBridge";
import { buildReplayFromExport, type SessionReplay } from "../sessionReplay";
import { consumeWatchReplayIntent, type WatchReplayIntent } from "../watchIntent";
import { gameLabel } from "../../shared/games";
import { CockpitPanel } from "./CockpitPanel";

/** A dashboard-opened replay: loading → ready | unavailable. */
type ReplayState =
  | { kind: "loading"; intent: WatchReplayIntent }
  | { kind: "ready"; intent: WatchReplayIntent; replay: SessionReplay }
  | { kind: "unavailable"; intent: WatchReplayIntent };

function isFixtureGame(g: string | undefined): g is (typeof FIXTURE_GAMES)[number] {
  return g !== undefined && (FIXTURE_GAMES as readonly string[]).includes(g);
}

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
  const [replay, setReplay] = useState<ReplayState | null>(null);

  // Dashboard handoff: consume the (single-shot) replay intent on mount and
  // load that session's stored frames. In the browser ?demo preview there is
  // no local store — the game's fixture stands in as the replay instead.
  useEffect(() => {
    const intent = consumeWatchReplayIntent();
    if (intent === null) return;
    if (window.aifight?.platform === "demo") {
      if (isFixtureGame(intent.game)) {
        const fix = FIXTURES[intent.game];
        setReplay({
          kind: "ready",
          intent,
          replay: {
            state: {
              ...emptyLiveMatch(),
              sessionId: intent.sessionId,
              game: intent.game,
              match: fix.match,
              events: fix.events,
              ownerPlayerId: fix.ownerPlayerId,
              ownerPrivate: fix.ownerPrivate,
              finished: true,
            },
            traces: synthesizeTraces(fix.match, fix.events, fix.ownerPlayerId),
          },
        });
      }
      return;
    }
    setReplay({ kind: "loading", intent });
    void cliRun(["sessions", "export", intent.sessionId]).then((r) => {
      if (r.exitCode !== 0 || r.error !== undefined || r.json === undefined) {
        setReplay({ kind: "unavailable", intent });
        return;
      }
      const built = buildReplayFromExport(r.json);
      if (built.state.match === null || built.state.game === null) {
        setReplay({ kind: "unavailable", intent });
        return;
      }
      setReplay({ kind: "ready", intent, replay: built });
    });
  }, []);

  // An explicit click outranks live/demo until the user closes it.
  if (replay !== null) {
    return <ReplayPane replay={replay} onClose={() => setReplay(null)} />;
  }

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

/** A dashboard-opened past match: close chrome + loading / unavailable /
 *  CockpitPanel replay parked at frame 0 (▶ is the user's call). */
function ReplayPane({ replay, onClose }: { replay: ReplayState; onClose: () => void }) {
  const { t } = useTranslation();
  const intent = replay.intent;

  const closeBtn = (
    <button
      onClick={onClose}
      className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
    >
      <X size={14} />
      {t("watch.closeReplay")}
    </button>
  );

  const centered = (body: ReactNode) => (
    <div className="flex h-full flex-col gap-3">
      <div>{closeBtn}</div>
      <div className="flex flex-1 items-center justify-center">
        <div className="flex max-w-md items-center gap-2 text-center text-[13px] text-[var(--text-muted)]">{body}</div>
      </div>
    </div>
  );

  if (replay.kind === "loading") {
    return centered(
      <>
        <Loader2 size={15} className="animate-spin" />
        {t("watch.replayLoading")}
      </>,
    );
  }
  if (replay.kind === "unavailable") {
    return centered(t("history.notRenderable"));
  }

  const { state, traces } = replay.replay;
  if (state.game === null || state.match === null) {
    return centered(t("history.notRenderable"));
  }

  const headerLeft = (
    <div className="flex flex-wrap items-center gap-2.5">
      {closeBtn}
      <span className="text-[13px] font-medium text-[var(--text)]">{gameLabel(state.game)}</span>
      {intent.resultLabel !== undefined && intent.resultLabel !== "" && (
        <span className="rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
          {intent.resultLabel}
        </span>
      )}
      {intent.replayUrl !== undefined && intent.replayUrl !== "" && (
        <a
          href={intent.replayUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ExternalLink size={13} />
          {t("cockpit.openReplay")}
        </a>
      )}
    </div>
  );

  return (
    <div className="h-full">
      <CockpitPanel
        key={`replay:${intent.sessionId}`}
        game={state.game}
        match={state.match}
        events={state.events}
        ownerPlayerId={state.ownerPlayerId ?? ""}
        ownerPrivate={state.ownerPrivate}
        traces={traces.slice()}
        isLive={false}
        badge="replay"
        note={t("history.replayNote")}
        initialStep={0}
        headerLeft={headerLeft}
      />
    </div>
  );
}
