// Battle-style radar card (ability-radar §6.3) — the dashboard's "what's my
// AI's playstyle" tile. Data comes from the agent-key self-view
// GET /api/agents/me/radar[/{game}] (community track, claim-independent), so
// it works before the agent is claimed — the claim gate only blocks third
// parties, never the mirror.
//
// Four states (§6.3):
//   1. enabled:false / fetch error / old server → the card renders NOTHING;
//   2. enabled but every axis dark (new agent)   → placeholder grid + unlock
//      copy + a "go play ranked" CTA (the app is the only surface with a CTA);
//   3. some axes lit                             → radar, dark axes dashed;
//   4. all lit                                   → radar + signature caption.
//
// The hexagon itself re-implements the shared render contract (§6.0) — the
// desktop cannot import the website's component, so the constants below must
// stay in lockstep with web/src/components/HexagonRadar.tsx: axis order
// clockwise from the top vertex, 5 grid rings (20..100), unlit axes dashed at
// 40% label opacity, single-layer brand orange #FF700A, sample-gate mirrors
// 30 (rate axes) / 10 (survival & versatility). Desktop-only addition (owner,
// 2026-07-02): lit vertices print their numeric score outside the corner —
// the web card keeps numbers hover-only.

import { useEffect, useState } from "react";

import { getOwnRadar } from "../useBridge";
import { gameLabel } from "../../shared/games";
import type { HexagonData } from "../../shared/ipc";

export const HEXAGON_DIMS = [
  "bluff",
  "aggression",
  "execution",
  "survival",
  "insight",
  "versatility",
] as const;

export type HexagonDim = (typeof HEXAGON_DIMS)[number];

/** Render-contract single-layer color (01 brand orange). */
const LAYER_COLOR = "#FF700A";

/** Mirror of the server's sample gates (internal/rating/hexagon.go).
 *  Execution's gate is mixed-unit server-side (30 Hold'em hands OR 10
 *  dice/coup matches); the hover hint uses the common 10-match case. */
const DIM_THRESHOLD: Record<HexagonDim, number> = {
  bluff: 30,
  aggression: 30,
  execution: 10,
  insight: 30,
  survival: 10,
  versatility: 10,
};

export type RadarView = "hidden" | "placeholder" | "partial" | "full";

/** Classify the §6.3 state machine. null = fetch failed / old server / off. */
export function radarView(d: HexagonData | null): RadarView {
  if (d === null || !d.enabled || d.dimensions === undefined) return "hidden";
  const lit = HEXAGON_DIMS.filter((k) => d.dimensions?.[k] != null).length;
  if (lit === 0) return "placeholder";
  return lit === HEXAGON_DIMS.length ? "full" : "partial";
}

/** Highest lit axis — the "signature" caption (ties break by axis order). */
export function radarSignature(d: HexagonData): { dim: HexagonDim; value: number } | null {
  let best: { dim: HexagonDim; value: number } | null = null;
  for (const k of HEXAGON_DIMS) {
    const v = d.dimensions?.[k];
    if (v != null && (best === null || v > best.value)) best = { dim: k, value: v };
  }
  return best;
}

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function axisTooltip(d: HexagonData | null, k: HexagonDim, t: TFunc): string {
  const parts = [t(`radar.desc.${k}`)];
  const lit = d?.dimensions?.[k] != null;
  const sample = d?.samples?.[k] ?? 0;
  if (lit) {
    const rate = d?.rates?.[k];
    if (rate != null) parts.push(t(`radar.rate.${k}`, { pct: Math.round(rate * 100) }));
    parts.push(t("radar.sample", { count: sample }));
  } else {
    parts.push(t("radar.needMore", { count: Math.max(1, DIM_THRESHOLD[k] - sample) }));
  }
  return parts.join(" · ");
}

/** The §6.0 contract hexagon: 5 rings, clockwise axes, dashed unlit axes.
 *  Desktop addition on top of the contract: each lit vertex shows its numeric
 *  score OUTSIDE the corner (name over value), sized for a 1/3-width column. */
export function StyleHexagon({ data, t }: { data: HexagonData | null; t: TFunc }) {
  const w = 340;
  const h = 290;
  const cx = w / 2;
  const cy = h / 2;
  const R = 100;

  const angle = (i: number) => ((-90 + i * 60) * Math.PI) / 180;
  const point = (i: number, value: number): readonly [number, number] => {
    const r = (R * Math.max(0, Math.min(100, value))) / 100;
    return [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];
  };
  const ringPath = (value: number) =>
    HEXAGON_DIMS.map((_, i) => point(i, value).join(",")).join(" ");

  const values = HEXAGON_DIMS.map((k) => data?.dimensions?.[k] ?? null);
  const anyLit = values.some((v) => v !== null);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img">
      {[20, 40, 60, 80, 100].map((v) => (
        <polygon
          key={v}
          points={ringPath(v)}
          fill="none"
          stroke="var(--border)"
          strokeWidth={v === 100 ? 1.2 : 0.6}
          opacity={v === 100 ? 0.9 : 0.55}
        />
      ))}
      {HEXAGON_DIMS.map((k, i) => {
        const [x, y] = point(i, 100);
        const lit = values[i] !== null;
        return (
          <line
            key={k}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="var(--text-faint)"
            strokeWidth={0.7}
            strokeDasharray={lit ? undefined : "4 4"}
            opacity={lit ? 0.55 : 0.4}
          />
        );
      })}
      {anyLit && (
        <polygon
          points={values.map((v, i) => point(i, v ?? 0).join(",")).join(" ")}
          fill={LAYER_COLOR}
          fillOpacity={0.15}
          stroke={LAYER_COLOR}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />
      )}
      {anyLit &&
        values.map((v, i) =>
          v !== null ? (
            <circle key={HEXAGON_DIMS[i]} cx={point(i, v)[0]} cy={point(i, v)[1]} r={2.6} fill={LAYER_COLOR} />
          ) : null,
        )}
      {HEXAGON_DIMS.map((k, i) => {
        const [x, y] = point(i, 100);
        const dx = x - cx;
        const onAxis = Math.abs(dx) < 8; // top / bottom vertex
        const anchor = onAxis ? "middle" : dx > 0 ? "start" : "end";
        const lx = x + (onAxis ? 0 : dx > 0 ? 8 : -8);
        // Two-line block outside the corner, always name-over-value: stacked
        // above the top vertex, below the bottom one, straddling side vertices.
        const nameY = onAxis ? (y < cy ? y - 20 : y + 14) : y - 3;
        const valueY = onAxis ? (y < cy ? y - 5 : y + 30) : y + 13;
        const lit = values[i] !== null;
        return (
          <g key={k}>
            <title>{axisTooltip(data, k, t)}</title>
            <text
              x={lx}
              y={nameY}
              textAnchor={anchor}
              fontSize={11.5}
              fill="var(--text)"
              opacity={lit ? 0.92 : 0.4}
              fontWeight={500}
            >
              {t(`radar.dims.${k}`)}
            </text>
            {lit && (
              <text
                x={lx}
                y={valueY}
                textAnchor={anchor}
                fontSize={14}
                fill={LAYER_COLOR}
                fontWeight={600}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {values[i]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The dashboard card. Fetches on mount and re-fetches when refreshSignal
 * changes (PlayView bumps it when a match finishes) or the game tab switches.
 * No polling, no stale cache: can't fetch → hide (§6.3 "简单可靠").
 */
export function StyleRadarCard({
  games,
  refreshSignal,
  onPlayCta,
  t,
}: {
  games: readonly string[];
  refreshSignal: number;
  onPlayCta?: () => void;
  t: TFunc;
}) {
  const [game, setGame] = useState("");
  const [data, setData] = useState<HexagonData | null>(null);
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    let alive = true;
    void getOwnRadar(game === "" ? undefined : game).then((d) => {
      if (!alive) return;
      setData(d);
      setProbed(true);
    });
    return () => {
      alive = false;
    };
  }, [game, refreshSignal]);

  const view = radarView(data);
  // State 1: feature off / error / old server → no card at all. While the
  // overall view has never answered, stay hidden too (no flicker).
  if (!probed || (view === "hidden" && game === "")) return null;

  const sig = data !== null ? radarSignature(data) : null;
  const showVersatilityNote = game !== ""; // single-game view: versatility is cross-game (§6.1)

  return (
    <div className="v3-dv-card px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="v3-dv-hd">
          {t("radar.title")}
          {view !== "placeholder" && sig !== null && (
            <span className="v3-dv-hnote ml-1 normal-case">
              {t("radar.signature", { dim: t(`radar.dims.${sig.dim}`), value: sig.value })}
            </span>
          )}
        </span>
        {games.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <button onClick={() => setGame("")} className={"v3-dv-minitab" + (game === "" ? " on" : "")}>
              {t("radar.overall")}
            </button>
            {games.map((g) => (
              <button key={g} onClick={() => setGame(g)} className={"v3-dv-minitab" + (game === g ? " on" : "")}>
                {gameLabel(g)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mx-auto max-w-[380px]">
        <StyleHexagon data={view === "hidden" ? null : data} t={t} />
      </div>

      {view === "placeholder" && (
        <div className="mt-1 flex flex-col items-center gap-2 pb-1 text-center">
          <p className="text-[12.5px] text-[var(--text-muted)]">{t("radar.unlockHint")}</p>
          {onPlayCta !== undefined && (
            <button onClick={onPlayCta} className="v3-dv-btn v3-dv-btn--oline v3-dv-btn--sm">
              {t("radar.playCta")}
            </button>
          )}
        </div>
      )}
      {showVersatilityNote && (
        <p className="mt-1 text-center text-[11px] text-[var(--text-faint)]">{t("radar.versatilityNote")}</p>
      )}
    </div>
  );
}
