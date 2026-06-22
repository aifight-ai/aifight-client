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
import { ReasoningTracePanel, type TraceBadge } from "./ReasoningTracePanel";
import { OwnHandStrip } from "./OwnHandStrip";
import type { BridgeDecisionTrace } from "../../shared/ipc";

export interface CockpitPanelProps {
  readonly game: Game;
  readonly match: MatchDetail;
  readonly events: readonly MatchEvent[];
  readonly ownerPlayerId: string;
  readonly ownerPrivate: OwnerPrivate;
  readonly traces: BridgeDecisionTrace[];
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
}

export function CockpitPanel(props: CockpitPanelProps) {
  const { t } = useTranslation();
  const { game, match, events, ownerPlayerId, ownerPrivate, traces, isLive, badge, note, emptyTraceHint, headerLeft } = props;

  const [step, setStep] = useState(events.length);
  const [playing, setPlaying] = useState(false);
  const [following, setFollowing] = useState(true);

  // Live: stick to the newest event while following.
  useEffect(() => {
    if (isLive && following) setStep(events.length);
  }, [isLive, following, events.length]);

  // Replay: timed auto-advance during playback.
  useEffect(() => {
    if (isLive || !playing) return;
    const len = events.length;
    if (step >= len) {
      setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => setStep((s) => Math.min(s + 1, len)), 1100);
    return () => window.clearTimeout(id);
  }, [isLive, playing, step, events.length]);

  const visible = events.slice(0, step);
  const atEnd = step >= events.length;

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {headerLeft}
        <div className="flex items-center gap-1.5">
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
          <span className="ml-1 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
            {step}/{events.length}
          </span>
        </div>
      </div>

      {/* Your agent's own private view — the only secrets the cockpit reveals. */}
      <OwnHandStrip game={game} owner={ownerPrivate} />

      <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row">
        <div className="min-w-0 xl:flex-1">
          {/* No isLive flag to the board: the owner's OWN cards (injected upstream)
              show at full fidelity; opponents stay hidden because nothing reveals
              them. ownerPlayerId is kept for parity with the trace attribution. */}
          <div className="aifight-game-canvas w-full overflow-hidden rounded-xl border border-[var(--border)]" data-owner={ownerPlayerId}>
            <GameStateVisual match={match} events={visible} />
          </div>
          <p className="mt-2 text-[12px] text-[var(--text-faint)]">{note}</p>
        </div>
        <div className="min-h-[320px] xl:h-auto xl:w-[340px] xl:shrink-0">
          <ReasoningTracePanel traces={traces} badge={badge} emptyHint={emptyTraceHint} />
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
      className={
        "flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] transition-colors " +
        (accent
          ? "bg-[var(--accent)] text-white hover:opacity-90"
          : "bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]")
      }
    >
      {children}
    </button>
  );
}
