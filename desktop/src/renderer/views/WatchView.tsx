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
import { appendFinalEvents, emptyLiveMatch, type MatchOutcome } from "../liveMatch";
import { getLiveStoreState, useLiveStore } from "../liveStore";
import { runCli, useBridgeStatus } from "../useBridge";
import { buildReplayFromExport, replayPathOf, type SessionReplay } from "../sessionReplay";
import { isSilentPastCutoff } from "../../shared/staleSession";
import { consumeWatchReplayIntent, replayIntentSupersededByLive, type WatchReplayIntent } from "../watchIntent";
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
    // A click on the CURRENTLY LIVE, unfinished session must not park a frozen
    // replay over a match that is still playing (owner report 2026-08-03: the
    // board showed only the steps loaded at open, never updating) — fall
    // through to the live cockpit instead. Finished/other sessions keep the
    // replay path.
    if (replayIntentSupersededByLive(intent.sessionId, getLiveStoreState().match)) return;
    setReplay({ kind: "loading", intent });
    void runCli({ kind: "sessionsExport", sessionId: intent.sessionId }).then((r) => {
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
      // A stored session's inbound frames end at this player's LAST decision —
      // same gap as the live stream — so the closing stretch (opponents' final
      // moves, showdown, result) comes from the finished match's public replay.
      // Best-effort: on any failure the replay stays as stored.
      const tailPath = replayPathOf(intent.replayUrl);
      if (tailPath !== null && typeof window.aifight?.getReplayTail === "function") {
        void window.aifight
          .getReplayTail(tailPath)
          .then((frames) => {
            if (frames === null || frames.length === 0) return;
            setReplay((cur) => {
              if (cur === null || cur.kind !== "ready" || cur.intent.sessionId !== intent.sessionId) return cur;
              const state = appendFinalEvents(cur.replay.state, frames);
              if (state === cur.replay.state) return cur;
              return { ...cur, replay: { state, traces: cur.replay.traces } };
            });
          })
          .catch(() => {});
      }
    });
  }, []);

  const isLive = liveMatch.sessionId !== null && liveMatch.match !== null;
  // A finished real match flips the cockpit from follow-the-tip to replay
  // transport: the board no longer "waits" on anyone (the final tail is loaded
  // by liveStore from the public replay), and play/restart replace the live
  // button. The key below remounts the panel so it re-parks at the final board.
  const finished = isLive && liveMatch.finished;
  const watchingLive = isLive && !finished;

  // A match killed server-side (deploy restart / cancel) never sends game_over,
  // so without this the cockpit shows LIVE on a dead board forever (the owner's
  // deploy-cancelled texas sat "live" all night, 2026-07-28). Silence past the
  // staleSession cutoff flips it to an interrupted replay. Zero events arriving
  // also means zero re-renders, so an interval re-evaluates the clock; if the
  // match somehow resumes (reconnect replays history), fresh activity flips it
  // straight back to LIVE.
  //
  // ⚠️ This hook pair MUST stay above the replay early-return below. It used to
  // live after it, so the render right after a dashboard replay intent landed
  // ran fewer hooks than the mount render — React throws "Rendered fewer hooks
  // than expected" and, with no boundary catching it, the whole window went
  // blank (owner report 2026-08-02: dashboard recent-match click white-screen).
  const [, setStaleTick] = useState(0);
  useEffect(() => {
    if (!watchingLive) return;
    const id = window.setInterval(() => setStaleTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [watchingLive]);

  // Resync race (renderer reload): the click can land BEFORE the live session
  // re-seeds (liveStore's snapshot IPC is still in flight), parking a frozen
  // replay of the very match that is live. Once the live session catches up to
  // the parked intent, yield to the live cockpit. Hook order: must stay above
  // the replay early-return below (same rule as the stale-tick pair).
  useEffect(() => {
    if (replay !== null && replayIntentSupersededByLive(replay.intent.sessionId, liveMatch)) {
      setReplay(null);
    }
  }, [replay, liveMatch]);

  // An explicit click outranks live/demo until the user closes it — except a
  // click on the live session itself, which the guards above route to the
  // live cockpit.
  if (replay !== null) {
    return <ReplayPane replay={replay} onClose={() => setReplay(null)} />;
  }

  const interrupted = watchingLive && isSilentPastCutoff(live.lastActivityAt, Date.now());
  // Receive-gap visibility (owner ask 2026-07-28): a live match that stops
  // producing frames looks identical to one that's merely thinking — surface
  // the silence itself once it exceeds a couple of minutes, well before the
  // 30-minute interrupted cutoff, so "the app stopped receiving" is a fact on
  // screen instead of a guess.
  const silentMin =
    watchingLive && !interrupted && live.lastActivityAt !== null
      ? Math.floor((Date.now() - live.lastActivityAt) / 60_000)
      : 0;

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
  const badge: "live" | "demo" | "replay" = finished || interrupted ? "replay" : hasLiveTraces || isLive ? "live" : "demo";

  // The bridge's turn authority, for the cockpit's turn strip + board-marker
  // correction (live, still-running match only): an open action_request means
  // OUR agent is deciding; anything else means we're waiting on the others.
  const turnState: "mine" | "waiting" | undefined =
    isLive && !finished && !interrupted ? (liveMatch.myTurn ? "mine" : "waiting") : undefined;

  const outcome = outcomeText(t, liveMatch.outcome);
  const replayHref =
    liveMatch.replayPath !== null ? replayOrigin(status?.config?.baseUrl) + liveMatch.replayPath : null;

  const headerLeft = isLive ? (
    <div className="v3-cp-info">
      {liveMatch.sessionId !== null && <span className="mid">{liveMatch.sessionId}</span>}
      <b>{gameLabel(boardGame)}</b>
      {liveMatch.finished ? (
        <span className="v3-cp-fin">{t("cockpit.finished")}</span>
      ) : interrupted ? (
        <span className="v3-cp-fin">{t("history.interrupted")}</span>
      ) : (
        <span className="v3-cp-live">
          <span className="v3-live-dot" />
          LIVE
        </span>
      )}
      {silentMin >= 2 && <span className="v3-cp-fin">{t("cockpit.silentFor", { m: silentMin })}</span>}
      {outcome !== null && <span className="v3-cp-outcome">{outcome}</span>}
      {replayHref !== null && (
        <a href={replayHref} target="_blank" rel="noreferrer" className="v3-cp-link">
          <ExternalLink size={13} />
          {t("cockpit.openReplay")}
        </a>
      )}
    </div>
  ) : (
    <div className="v3-dv-seg">
      {FIXTURE_GAMES.map((g) => (
        <button key={g} onClick={() => setDemoGame(g)} className={"v3-dv-seg-btn" + (demoGame === g ? " on" : "")}>
          {gameLabel(g)}
        </button>
      ))}
      <span className="ml-1 flex items-center px-1.5 font-mono text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
        {t("cockpit.demoMatch")}
      </span>
    </div>
  );

  // v3 顶条右侧:桥接状态芯片(真实 bridge phase,running 时附直连标注)。
  const bridgeOnline = status?.phase === "running";
  const bridgeChip = (
    <span className="v3-bridge-chip" data-on={bridgeOnline ? "1" : "0"} title={status?.message ?? undefined}>
      <i />
      {t(`bridge.phase.${status?.phase ?? "idle"}`)}
      {bridgeOnline ? ` · ${t("app.tagline")}` : ""}
    </span>
  );

  return (
    <div className="flex h-full flex-col gap-3">
      {!isLive && (
        <div className="v3-dv-banner shrink-0" data-tone="accent">
          {t("watch.demoBanner")}
        </div>
      )}
      {/* F2: the synthetic own-action was rolled back unconfirmed — the board
          stepped back to the last server-confirmed state. */}
      {isLive && liveMatch.syncNotice === "action_unconfirmed" && (
        <div className="v3-dv-banner shrink-0" data-tone="warn">
          {t("cockpit.actionUnconfirmed")}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CockpitPanel
          key={`${match.id}:${finished ? "fin" : interrupted ? "int" : isLive ? "live" : "demo"}`}
          game={boardGame}
          match={match}
          events={events}
          ownerPlayerId={ownerPlayerId}
          ownerPrivate={ownerPrivate}
          traces={traces.slice()}
          isLive={isLive && !finished && !interrupted}
          badge={badge}
          turnState={turnState}
          note={
            finished
              ? t("cockpit.finishedNote")
              : interrupted
                ? t("cockpit.interruptedNote")
                : isLive
                  ? t("cockpit.liveNote")
                  : t("cockpit.note")
          }
          emptyTraceHint={isLive && !finished && !interrupted ? t("cockpit.waitingTrace") : undefined}
          headerLeft={headerLeft}
          headerRight={bridgeChip}
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
    <button onClick={onClose} className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm">
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
        <span className="v3-dv-chip">{intent.resultLabel}</span>
      )}
      {intent.replayUrl !== undefined && intent.replayUrl !== "" && (
        <a href={intent.replayUrl} target="_blank" rel="noreferrer" className="v3-cp-link">
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
