// Shared presentation primitives that give the desktop the v3 editorial look: an
// orange-square mono uppercase eyebrow, a Space Grotesk display title, a muted
// subtitle, and a raised hairline card (v3-dv-* classes, see v3-cockpit.css §P4b).
// Keeping them here means every view reads the same — change the rhythm once, it
// updates everywhere. Pure presentation, no state.

import type { ReactNode } from "react";

/** v3 eyebrow — orange square + small uppercase mono kicker (design: .eyebrow).
 *  Was the website's plain orange kicker; the square lands the v3 signature. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={"v3-dv-eyebrow " + className}>{children}</div>;
}

/**
 * The website's page-header rhythm: eyebrow → large serif title → muted subtitle,
 * with an optional right-aligned action/control slot. Used at the top of each view.
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  right,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={"mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 " + className}>
      <div className="min-w-0">
        {eyebrow !== undefined && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
        <h1 className="v3-dv-display text-[26px] leading-tight text-[var(--text)]">{title}</h1>
        {subtitle !== undefined && (
          <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-[var(--text-muted)]">{subtitle}</p>
        )}
      </div>
      {right !== undefined && <div className="shrink-0">{right}</div>}
    </div>
  );
}

/** Raised v3 panel card (warm surface + hairline + paper shadow). */
export function Card({
  children,
  className = "",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return <div className={"v3-dv-card " + (hover ? "v3-dv-card--hover " : "") + className}>{children}</div>;
}

/** Fully-rounded mono uppercase chip — the v3 badge/tag style. `tone` picks the palette. */
export function Chip({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "live";
  className?: string;
}) {
  return (
    <span className={"v3-dv-chip " + className} data-tone={tone}>
      {children}
    </span>
  );
}
