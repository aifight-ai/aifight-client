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

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, SkipBack, SkipForward, RotateCcw, Radio } from "lucide-react";

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

export function CockpitPanel(props: CockpitPanelProps) {
  const { t } = useTranslation();
  const { game, match, events, ownerPlayerId, ownerPrivate, traces, isLive, badge, note, emptyTraceHint, headerLeft, headerRight } = props;
  const fill = props.fill ?? true;

  const [step, setStep] = useState(props.initialStep ?? events.length);
  const [playing, setPlaying] = useState(false);
  const [following, setFollowing] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Live: stick to the newest event while following.
  useEffect(() => {
    if (isLive && following) setStep(events.length);
  }, [isLive, following, events.length]);

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
          <div className="v3-cp-transport">
            {!isLive && (
              <TransportButton title={t("cockpit.restart")} onClick={() => stepTo(0)}>
                <RotateCcw size={15} />
              </TransportButton>
            )}
            <TransportButton title={t("cockpit.prev")} onClick={() => stepTo(step - 1)}>
              <SkipBack size={15} />
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
        <div className="min-h-[320px] xl:h-auto xl:w-[340px] xl:shrink-0">
          <ReasoningTracePanel traces={traces} badge={badge} emptyHint={emptyTraceHint} onJumpToStep={stepTo} />
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
