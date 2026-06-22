// Shared presentation primitives that give the desktop the website's editorial
// look: a mono uppercase orange eyebrow, a serif display title, a muted subtitle,
// and a raised "paper" card. Keeping them here means every view reads the same —
// change the rhythm once, it updates everywhere. Pure presentation, no state.

import type { ReactNode } from "react";

/** Small uppercase mono kicker in the brand orange — the website's signature eyebrow. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={"font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--accent-text)] " + className}>
      {children}
    </div>
  );
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
        <h1 className="font-display text-[26px] leading-tight text-[var(--text)]">{title}</h1>
        {subtitle !== undefined && (
          <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-[var(--text-muted)]">{subtitle}</p>
        )}
      </div>
      {right !== undefined && <div className="shrink-0">{right}</div>}
    </div>
  );
}

/** Raised paper-card surface (mirrors the website's .card-raised). */
export function Card({
  children,
  className = "",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return <div className={"app-card " + (hover ? "app-card-hover " : "") + className}>{children}</div>;
}

/** Fully-rounded mono uppercase chip — the website's badge/tag style. `tone` picks the palette. */
export function Chip({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "live";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-[var(--surface-2)] text-[var(--text-muted)]",
    accent: "bg-[var(--accent-soft)] text-[var(--accent-text)]",
    ok: "bg-emerald-500/15 text-emerald-400",
    live: "bg-[var(--accent-soft)] text-[var(--accent-text)]",
  };
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] " +
        tones[tone] +
        " " +
        className
      }
    >
      {tone === "live" && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {children}
    </span>
  );
}
