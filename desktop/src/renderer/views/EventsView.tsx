// Feature 3 — events (赛事). Lists the platform's PUBLIC events in-app; viewing
// full standings + registering happens on the web event page (event registration
// is an account-level / owner-JWT action), so each card deep-links out via the
// browser. The external link goes through main's setWindowOpenHandler → the OS
// browser, never an in-app window. Styled to match the website's editorial cards.
//
// The backend returns up to 50 public events with no filter params, so the status
// filter is applied client-side over what we already fetched.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Users, RotateCw } from "lucide-react";

import { getEvents, useBridgeStatus } from "../useBridge";
import { webOrigin } from "../webOrigin";
import { Card, Chip, Eyebrow, PageHeader } from "../components/ui";
import { gameLabel } from "../../shared/games";
import type { EventCard } from "../../shared/ipc";

// Client-side status filter buckets (the API exposes no status param).
const STATUS_FILTERS = ["all", "published", "active", "completed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

type ChipTone = "neutral" | "accent" | "ok" | "live";
function statusTone(status: string): ChipTone {
  if (status === "active") return "ok";
  if (status === "published") return "accent";
  return "neutral";
}

function fmtDate(iso: string | null, locale: string): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; events: EventCard[] };

export function EventsView() {
  const { t, i18n } = useTranslation();
  const status = useBridgeStatus();
  const origin = webOrigin(status?.config?.baseUrl);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    void getEvents()
      .then((data) => {
        if (!alive) return;
        setState(data === null ? { kind: "error" } : { kind: "ready", events: data.events });
      })
      .catch(() => {
        if (alive) setState({ kind: "error" });
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  const statusLabel = (s: string): string => t(`events.status.${s}`, { defaultValue: s });
  const typeLabel = (s: string): string => t(`events.type.${s}`, { defaultValue: s });
  const filterLabel = (s: StatusFilter): string => (s === "all" ? t("common.all") : statusLabel(s));

  const all = state.kind === "ready" ? state.events : [];
  const events = all.filter((ev) => filter === "all" || ev.status === filter);

  const right = (
    <button
      onClick={() => setNonce((n) => n + 1)}
      title={t("common.refresh")}
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
    >
      <RotateCw size={14} className={state.kind === "loading" ? "animate-spin" : ""} />
    </button>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow={t("eyebrow.events")} title={t("nav.events")} subtitle={t("hint.events")} right={right} />

      <p className="mb-3 text-[12px] text-[var(--text-muted)]">{t("events.regNote")}</p>

      {state.kind === "ready" && all.length > 0 && (
        <div className="mb-3 inline-flex gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={
                "rounded-md px-2.5 py-1 text-[12px] transition-colors " +
                (filter === s ? "bg-[var(--surface)] text-[var(--text)] shadow-sm" : "text-[var(--text-muted)] hover:text-[var(--text)]")
              }
            >
              {filterLabel(s)}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {events.map((ev) => {
          const reg = fmtDate(ev.registrationEndsAt, i18n.language);
          const playStart = fmtDate(ev.playStartsAt, i18n.language);
          const playEnd = fmtDate(ev.playEndsAt, i18n.language);
          return (
            <Card key={ev.slug} hover className="p-5">
              {ev.eventType !== "" && <Eyebrow className="mb-2">{typeLabel(ev.eventType)}</Eyebrow>}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-[18px] leading-snug text-[var(--text)]">{ev.title}</h3>
                    {ev.status !== "" && <Chip tone={statusTone(ev.status)}>{statusLabel(ev.status)}</Chip>}
                  </div>
                  {ev.subtitle !== "" && <p className="mt-1 text-[13px] text-[var(--text-muted)]">{ev.subtitle}</p>}
                </div>
                <a
                  href={`${origin}/events/${encodeURIComponent(ev.slug)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  <ExternalLink size={13} />
                  {t("events.view")}
                </a>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px] text-[var(--text-faint)]">
                {ev.games.length > 0 && <span>{ev.games.map((g) => gameLabel(g)).join(" · ")}</span>}
                {ev.prizeSummary !== "" && <span className="font-medium text-[var(--accent-text)]">{ev.prizeSummary}</span>}
                <span className="inline-flex items-center gap-1">
                  <Users size={12} /> {t("events.participants", { n: ev.participantCount })}
                </span>
                {reg !== null && (
                  <span>
                    {t("events.regEnds")}: {reg}
                  </span>
                )}
                {playStart !== null && playEnd !== null && (
                  <span>
                    {playStart} – {playEnd}
                  </span>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {state.kind === "loading" && (
        <Card className="px-4 py-12 text-center text-[13px] text-[var(--text-muted)]">{t("events.loading")}</Card>
      )}
      {state.kind === "error" && (
        <Card className="px-4 py-12 text-center text-[13px] text-[var(--text-muted)]">{t("events.errorLoad")}</Card>
      )}
      {state.kind === "ready" && events.length === 0 && (
        <Card className="px-4 py-14 text-center">
          <div className="font-display text-[40px] italic leading-none text-[var(--border)]">—</div>
          <div className="mt-3 text-[13px] text-[var(--text-muted)]">{all.length === 0 ? t("events.empty") : t("events.noMatch")}</div>
        </Card>
      )}
    </div>
  );
}
