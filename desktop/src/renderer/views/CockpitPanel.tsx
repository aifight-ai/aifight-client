// D8 — the shared cockpit surface: board (website renderer) + "your agent"
// private strip + reasoning-trace panel + a replay/live transport. Both the live
// Watch view and the History replay render through this one component, so a past
// match looks exactly like a live one.
//
// Source data (match / events / ownerPlayerId / ownerPrivate) comes in as props;
// this component owns only the transport (step / playback / follow-live). Mount
// it with a `key` tied to the match identity so switching matches resets the
// transport cleanly.
//
// 🔒 It renders whatever events it is given and only the owner's ownerPrivate —
// it never derives opponent secrets. The caller (liveMatch / sessionReplay) is
// responsible for never putting an opponent's hidden info into these props.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, Radio } from "lucide-react";

import { GameStateVisual } from "@aifight/ui";
import type { MatchDetail, MatchEvent } from "@aifight/api-types";
import type { Game, OwnerPrivate } from "../liveMatch";
import type { StampedTrace } from "../liveStore";
import { ReasoningTracePanel, type TraceBadge } from "./ReasoningTracePanel";
import { OwnHandStrip } from "./OwnHandStrip";
import { TruncationBanner } from "./TruncationBanner";
import { DecisionErrorBanner } from "./DecisionErrorBanner";

export interface CockpitPanelProps {
  readonly game: Game;
  readonly match: MatchDetail;
  readonly events: readonly MatchEvent[];
  readonly ownerPlayerId: string;
  readonly ownerPrivate: OwnerPrivate;
  readonly traces: readonly StampedTrace[];
  /** Transport mode: live = follow-the-tip (Radio button); replay = play/restart. */
  readonly isLive: boolean;
  /** Reasoning panel badge: live / demo / replay. */
  readonly badge: TraceBadge;
  /** Bottom note under the board. */
  readonly note: string;
  /** Empty-state text for the reasoning panel. */
  readonly emptyTraceHint?: string;
  /** Left side of the control row (game switcher / live status / session label). */
  readonly headerLeft: ReactNode;
  /** Right side of the top bar, before the transport (e.g. the bridge-status chip). */
  readonly headerRight?: ReactNode;
  /**
   * Initial transport position; defaults to the tip (events.length, the final
   * board). A dashboard-opened replay passes 0 so it waits at the first frame
   * for the user to press play — loaded, never auto-started.
   */
  readonly initialStep?: number;
  /**
   * Layout mode. true (default) = fill the viewport (Watch/Replay panes: the
   * cockpit IS the page). false = natural document height, for pages that stack
   * more content BELOW the cockpit (History detail stacks the self-review
   * card). In fill mode a board taller than the viewport used to bleed out of
   * its height-capped flex cell and paint OVER whatever followed — the owner
   * hit exactly that: the review card's Generate button floating on top of the
   * Texas hand ledger (2026-07-28).
   */
  readonly fill?: boolean;
}

/** Replay auto-advance speeds — the same dial the website's replay page offers. */
const SPEEDS = [0.5, 1, 1.5, 3];

/**
 * F1 catch-up policy (pure, exported for tests): when the live log grows while
 * following, how should the transport reach the new tip?
 *  - 1 new step: jump straight to it — a single move should feel instant.
 *  - a batch: walk one step per CATCHUP_STEP_MS so a burst of opponent moves
 *    plays out like a broadcast instead of a hard jump (the 111→120 jump the
 *    owner hit).
 *  - a huge backlog (reconnect replay / long offline stretch): converge
 *    immediately, or the board would lag further and further behind live.
 */
export const CATCHUP_STEP_MS = 600;
export const CATCHUP_MAX_QUEUE = 12;
export function liveCatchUpPlan(backlog: number): { readonly kind: "jump" } | { readonly kind: "wait" } | { readonly kind: "none" } {
  if (backlog <= 0) return { kind: "none" };
  if (backlog === 1 || backlog > CATCHUP_MAX_QUEUE) return { kind: "jump" };
  return { kind: "wait" };
}

export function CockpitPanel(props: CockpitPanelProps) {
  const { t } = useTranslation();
  const { game, match, events, ownerPlayerId, ownerPrivate, traces, isLive, badge, note, emptyTraceHint, headerLeft, headerRight } = props;
  const fill = props.fill ?? true;

  const [step, setStep] = useState(props.initialStep ?? events.length);
  const [playing, setPlaying] = useState(false);
  const [following, setFollowing] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Live: stick to the newest event while following — but NEVER hard-jump a
  // batch (F1). A multi-step arrival (an action_request's new_events bundle or
  // a polled participant-feed merge) walks to the tip at the catch-up cadence
  // so the board plays out like a broadcast; a parked user (following=false,
  // they scrubbed by hand) is never disturbed. The catch-up only ever advances
  // +1 per tick, so a burst arriving mid-walk simply extends the queue.
  useEffect(() => {
    if (!isLive || !following) return;
    const plan = liveCatchUpPlan(events.length - step);
    if (plan.kind === "none") return;
    if (plan.kind === "jump") {
      setStep(events.length);
      return;
    }
    const id = window.setTimeout(() => setStep((s) => Math.min(s + 1, events.length)), CATCHUP_STEP_MS);
    return () => window.clearTimeout(id);
  }, [isLive, following, step, events.length]);

  // Replay: when the event log EXTENDS (the finished match's public-replay tail
  // merging in after mount — it always lands late, the replay row is written at
  // settlement), a transport parked at the old tip follows to the new tip.
  // Without this the "re-park at the final board" promise silently broke: the
  // panel remounted at game_over with the pre-tail length and then sat mid-
  // showdown once the tail arrived. A user who already scrubbed elsewhere is
  // left alone.
  const prevLenRef = useRef(events.length);
  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = events.length;
    if (isLive || events.length <= prev) return;
    setStep((s) => (s >= prev ? events.length : s));
  }, [events.length, isLive]);

  // Replay: timed auto-advance during playback, paced by the speed dial
  // (base 1100ms/step — the same cadence the website's replay page uses at 1×).
  useEffect(() => {
    if (isLive || !playing) return;
    const len = events.length;
    if (step >= len) {
      setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => setStep((s) => Math.min(s + 1, len)), 1100 / speed);
    return () => window.clearTimeout(id);
  }, [isLive, playing, step, events.length, speed]);

  const visible = events.slice(0, step);
  const atEnd = step >= events.length;

  // Replay/demo: the reasoning panel tracks the transport — a decision's trace
  // appears only once the board has reached the step it was taken at, exactly
  // like the live stream builds up. Without this, a replay parked mid-match
  // already showed EVERY later decision on the right while the board sat
  // earlier (board/panel desync; also spoils the run-out when stepping
  // through). Unstamped traces (older stored sessions) stay always-visible.
  // Live keeps the full stream visible — arrival order IS the live experience —
  // but the panel's "current" anchor still follows the transport (transportStep,
  // F3), so scrubbing back mid-live re-anchors to the decision of THAT step.
  const shownTraces = isLive ? traces : traces.filter((tr) => tr.step === undefined || tr.step <= step);

  // v3: which seat is "your agent" — derived from the same props the board
  // already gets (no new data). The canvas carries it as data-owner-seat so the
  // v3 stylesheet can paint the persistent orange edge + YOUR AGENT badge on
  // that seat card (and only that one).
  const ownerSeat =
    ownerPlayerId === ""
      ? -1
      : match.players.findIndex(
          (p) => (p.player_id || `p${p.position}`) === ownerPlayerId || p.agent_id === ownerPlayerId,
        );

  const stepTo = (n: number) => {
    setPlaying(false);
    if (isLive) setFollowing(false);
    setStep(Math.max(0, Math.min(events.length, n)));
  };
  const togglePlay = () => {
    if (atEnd) setStep(0);
    setPlaying((p) => !p);
  };
  const goLive = () => {
    setFollowing(true);
    setStep(events.length);
  };

  // Keyboard transport: ←/→ step, space play/pause (replay) or re-follow (live).
  // Skipped while focus sits in a form control so typing never scrubs the board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepTo(step - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepTo(step + 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        stepTo(0);
      } else if (e.key === "End") {
        e.preventDefault();
        stepTo(events.length);
      } else if (e.key === " ") {
        e.preventDefault();
        if (isLive) goLive();
        else togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={fill ? "v3-cockpit flex h-full min-h-0 flex-col gap-3" : "v3-cockpit flex flex-col gap-3"}>
      {/* ① v3 顶条:对局信息(左) + 桥接芯片/走带(右) */}
      <div className="v3-cp-top">
        <div className="v3-cp-left">{headerLeft}</div>
        <div className="v3-cp-right">
          {headerRight}
          {/* Full five-key transport (owner ask 2026-07-28): ⏮ first / ◀ prev /
              ▶|Radio / ▶ next / ⏭ last. SkipBack/SkipForward now mean what
              their bar-glyphs say — jump to the ends; single-stepping moved to
              the chevrons. In live, ⏭ jumps to the newest step WITHOUT
              re-following; Radio is the "follow the tip again" switch. */}
          <div className="v3-cp-transport">
            <TransportButton title={t("cockpit.toStart")} onClick={() => stepTo(0)}>
              <SkipBack size={15} />
            </TransportButton>
            <TransportButton title={t("cockpit.prev")} onClick={() => stepTo(step - 1)}>
              <ChevronLeft size={15} />
            </TransportButton>
            {isLive ? (
              <TransportButton title={t("cockpit.liveMatch")} onClick={goLive} accent={!following}>
                <Radio size={15} />
              </TransportButton>
            ) : (
              <TransportButton title={playing ? t("cockpit.pause") : t("cockpit.play")} onClick={togglePlay} accent>
                {playing ? <Pause size={15} /> : <Play size={15} />}
              </TransportButton>
            )}
            <TransportButton title={t("cockpit.next")} onClick={() => stepTo(step + 1)}>
              <ChevronRight size={15} />
            </TransportButton>
            <TransportButton title={t("cockpit.toEnd")} onClick={() => stepTo(events.length)}>
              <SkipForward size={15} />
            </TransportButton>
            {!isLive && (
              <button
                className="v3-cp-speed"
                title={t("cockpit.speed")}
                onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
              >
                {speed}×
              </button>
            )}
            <input
              type="range"
              className="v3-cp-slider"
              title={t("cockpit.seek")}
              aria-label={t("cockpit.seek")}
              min={0}
              max={events.length}
              value={Math.min(step, events.length)}
              // F5: played-fill percentage for the track's linear-gradient.
              style={{ "--v3-fill": `${events.length === 0 ? 0 : (Math.min(step, events.length) / events.length) * 100}%` } as CSSProperties}
              onChange={(e) => stepTo(Number(e.target.value))}
            />
            <span className="v3-cp-count">
              {step}/{events.length}
            </span>
          </div>
        </div>
      </div>

      {/* Token-budget guard: warn (live only) when decisions were truncated. */}
      <TruncationBanner traces={traces} isLive={isLive} />

      {/* Error-class guard: warn (live only) when decisions fell back on a fatal
          API error (auth / quota / config / content_filter). */}
      <DecisionErrorBanner traces={traces} isLive={isLive} />

      {/* Your agent's own private view — the only secrets the cockpit reveals.
          Texas doesn't need it (the board seats the owner's hole cards via the
          injected cards_dealt event), so there it was pure duplication — owner
          ruling 2026-07-28: dropped. Dice/Coup keep it because the shared board
          renderer has no slot for "my own hidden dice/roles"; shown ONLY at the
          tip, because ownerPrivate is always the LATEST snapshot — pinning it
          over a scrubbed-back board would caption old positions with new
          secrets. */}
      {game !== "texas_holdem" && atEnd && <OwnHandStrip game={game} owner={ownerPrivate} />}

      <div className={fill ? "flex min-h-0 flex-1 flex-col gap-3 xl:flex-row" : "flex flex-col gap-3 xl:flex-row"}>
        <div className="min-w-0 xl:flex-1">
          {/* No isLive flag to the board: the owner's OWN cards (injected upstream)
              show at full fidelity; opponents stay hidden because nothing reveals
              them. ownerPlayerId is kept for parity with the trace attribution.
              data-owner-seat drives the v3 "YOUR AGENT" seat styling (CSS only). */}
          <div
            className="aifight-game-canvas"
            data-owner={ownerPlayerId}
            data-owner-seat={ownerSeat >= 0 ? String(ownerSeat) : undefined}
          >
            <GameStateVisual match={match} events={visible} />
          </div>
          <p className="v3-board-note">{note}</p>
        </div>
        {/* fill=false (History detail, document flow): without a bounded height
            the trace panel renders EVERY trace and the page grows without end
            (owner report 2026-07-28) — cap it so the panel scrolls internally,
            sticky beside the board on wide layouts. fill mode keeps the
            viewport-driven height it always had. */}
        <div
          className={
            fill
              ? "min-h-[320px] xl:h-auto xl:w-[340px] xl:shrink-0"
              : "h-[420px] xl:sticky xl:top-4 xl:h-[calc(100vh-8rem)] xl:w-[340px] xl:shrink-0"
          }
        >
          <ReasoningTracePanel
            traces={shownTraces}
            badge={badge}
            emptyHint={emptyTraceHint}
            onJumpToStep={stepTo}
            transportStep={step}
          />
        </div>
      </div>
    </div>
  );
}

function TransportButton({
  title,
  onClick,
  accent,
  children,
}: {
  title: string;
  onClick: () => void;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={"v3-tbtn" + (accent ? " v3-tbtn--acc" : "")}
    >
      {children}
    </button>
  );
}
