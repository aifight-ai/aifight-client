// D7 + D11 — the home. Three states:
//   unconfigured → Onboarding (register a new direct-LLM agent, or connect with
//     a pairing code);
//   freshly registered → SetupGuide (one-screen first-run setup: the daily
//     auto-match cap — the token-burn safety — plus LLM key + claim checklist);
//   configured → Dashboard (wide command-center: identity hero, KPI strip,
//     rating trend, auto-match control, LOCAL token usage, per-game cards,
//     recent matches, quick actions).
// Lifecycle: opening the app IS being online (no manual online/offline toggle —
// main.ts auto-connects on launch). Automatic matchmaking is platform-paced and
// capped by a daily limit N; manual "play now" + challenges are explicit and NOT
// subject to N. Every action runs the SAME engine/config the CLI uses.

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  UserPlus, Link2, Loader2, Copy, Check, Swords, Pause, Play, RefreshCw,
  ShieldAlert, ExternalLink, Percent, Gauge, Trophy, Globe, LayoutDashboard,
  Coins, Zap, Cpu, AlertTriangle, Pencil, X, type LucideIcon,
} from "lucide-react";

import {
  useBridgeStatus, runCli, bridgeStart, requestMatches, setMatchingPaused, openClaim, openDashboard,
  acceptLegal, openLegal,
  getAgentProfile, getOwnProfileRaw, getAgentPolicy, setAgentPolicy, setAgentName, getUsageOverview, resultText,
  getLLMConfig, desktopAvatarActions,
} from "../useBridge";
import { localizeServerError, isClaimNameError } from "../errors";
import { computeRankedHint } from "../rankedHint";
import { PageHeader, Chip } from "../components/ui";
import { AgentAvatar } from "@aifight/ui";
import { AvatarPicker } from "@aifight/ui";
import { webOrigin } from "../webOrigin";
import { useLiveStore } from "../liveStore";
import { useLiveGames } from "../liveGames";
import { setWatchReplayIntent } from "../watchIntent";
import { gameLabel } from "../../shared/games";
import { RatingChart, PerGameCards, AchievementShelf } from "./AgentProfileViz";
import { StyleRadarCard } from "./StyleRadarCard";
import type { AgentProfile } from "@aifight/api-types";
import type { AgentPolicy, AgentProfileData, AgentStats, BridgeStatus, CliOp, UsageOverview } from "../../shared/ipc";

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : 0)));
}

/** Group the 10-digit numeric public ID as 3-3-4 (mirrors server publicno.Format
 *  / runtime account/public-no). Out-of-range / 0 → "" so the chip is hidden. */
function formatPublicNo(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 1_000_000_000 || n > 9_999_999_999) return "";
  const s = String(n);
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6, 10)}`;
}

/** Above this many automatic matches per day the UI requires a second, explicit
 *  confirmation — the cap exists as a token-burn safety, and >10/day can mean
 *  thousands of model calls. Mirrored by the CLI (`aifight set daily`). */
export const CAP_CONFIRM_THRESHOLD = 10;

/** Highest per-day automatic-match cap the in-app slider lets a user dial in.
 *  Matches the server's default ceiling (agent_daily_ranked_cap). The server clamps
 *  to its live ceiling regardless, so this is only the UI bound. */
export const CAP_MAX = 100;

export function capNeedsConfirm(next: number): boolean {
  return next > CAP_CONFIRM_THRESHOLD;
}

/** Compact token formatter: 412 → "412", 41_200 → "41.2k", 6_421_337 → "6.4M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Division ladder — same thresholds as the website's agent profile. */
export function divisionOf(rating: number | null, totalGames: number): string {
  if (rating === null || totalGames < 5) return "provisional";
  if (rating >= 1900) return "champion";
  if (rating >= 1750) return "master";
  if (rating >= 1650) return "diamond";
  if (rating >= 1550) return "gold";
  if (rating >= 1450) return "silver";
  return "bronze";
}

/** Derived agent activity for the hero status pill. */
type Activity = "offline" | "in_match" | "paused" | "resting" | "idle" | "matching";

/** Activity → v3-dv-pill tone(v3:实时/橘,在线/绿,警示/琥珀,错误/红,其余中性)。 */
const ACTIVITY_TONE: Record<Activity, string> = {
  offline: "err",
  in_match: "accent",
  matching: "ok",
  resting: "warn",
  idle: "neutral",
  paused: "neutral",
};

// ── Cockpit cache ────────────────────────────────────────────────────────────
// Switching tabs unmounts/remounts the dashboard, so seeding fields from a
// hardcoded default made the daily cap flash (snap 2 → server value) on every
// visit. This cache holds the last-known values so a remount shows them
// instantly; the async refresh on mount only reconciles with the server.
// Session-scoped vars survive tab switches; the policy is also mirrored to
// localStorage so the cap survives an app restart. The time-sensitive
// games_today is NOT persisted — it must always come fresh from the server.
type ClaimState = "unknown" | "claimed" | "unclaimed";
/** A challenge the user created this session (URL to share). */
interface CreatedChallenge {
  game: string;
  url: string;
}
/** Bottom-of-dashboard action feedback. `err` renders red (styled-as-error);
 *  `action: "claim"` adds a "set the name" button right at the failure point
 *  (the claim/official-name gate, D4). Replaced on every action → self-clearing. */
type Feedback = { tone: "ok" | "err"; text: string; action?: "claim" } | null;
const POLICY_CACHE_KEY = "aifight.play.policy";
// Whether the user paused automatic matchmaking. PERSISTED (not session-only):
// pausing is a token-burn / spend decision, so it must survive a relaunch — main
// auto-joins the pool on launch, and the dashboard re-applies this pause once the
// bridge is online (see the re-apply effect) so spend doesn't silently resume.
const PAUSE_KEY = "aifight.play.paused";

function readPersistedPause(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(PAUSE_KEY) === "1";
  } catch {
    return false;
  }
}
/** Set to the agentId right after a fresh registration; the SetupGuide shows
 *  until the user finishes/skips it. Keyed by agent so connecting an existing
 *  agent (pairing) never triggers the first-run guide. */
const GUIDE_PENDING_KEY = "aifight.guide.pending";

function readPersistedPolicy(): AgentPolicy | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(POLICY_CACHE_KEY);
    return raw !== null ? (JSON.parse(raw) as AgentPolicy) : null;
  } catch {
    return null;
  }
}

let cachedPolicy: AgentPolicy | null = readPersistedPolicy();
let cachedProfile: AgentProfileData | null = null;
let cachedRaw: AgentProfile | null = null;
let cachedClaim: ClaimState = "unknown";
let cachedUsage: UsageOverview | null = null;

function rememberPolicy(p: AgentPolicy): void {
  cachedPolicy = p;
  try {
    if (typeof localStorage === "undefined") return;
    // Drop the live games_today before persisting; it must not survive a restart.
    const { gamesToday: _omit, ...rest } = p;
    void _omit;
    localStorage.setItem(POLICY_CACHE_KEY, JSON.stringify(rest));
  } catch {
    /* ignore quota / serialization errors */
  }
}

function guidePendingFor(agentId: string | undefined): boolean {
  try {
    return agentId !== undefined && typeof localStorage !== "undefined" && localStorage.getItem(GUIDE_PENDING_KEY) === agentId;
  } catch {
    return false;
  }
}

/** First-run guide progress, persisted per agent. The guide re-shows on every
 *  return until the user hits "Enter" (step 3 "Open Models" navigates away and
 *  back), so its step state must survive a remount — otherwise the name/cap the
 *  user already set reset to blank and "Enter" re-locks. Keyed by agentId so a
 *  replaced/paired agent starts fresh. `cap` = the value the user EXPLICITLY
 *  applied (null = not yet); that conscious choice is what unlocks "Enter". */
const GUIDE_PROGRESS_KEY = "aifight.guide.progress";
export interface GuideProgress {
  agentId: string;
  nameDone: boolean;
  cap: number | null;
}
export function readGuideProgress(agentId: string | undefined): GuideProgress | null {
  if (agentId === undefined) return null;
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(GUIDE_PROGRESS_KEY);
    if (raw === null) return null;
    const p = JSON.parse(raw) as GuideProgress;
    // Ignore a prior agent's progress (e.g. after "replace identity").
    return p.agentId === agentId ? p : null;
  } catch {
    return null;
  }
}
export function saveGuideProgress(agentId: string | undefined, patch: Partial<Omit<GuideProgress, "agentId">>): void {
  if (agentId === undefined) return;
  try {
    if (typeof localStorage === "undefined") return;
    const cur = readGuideProgress(agentId) ?? { agentId, nameDone: false, cap: null };
    localStorage.setItem(GUIDE_PROGRESS_KEY, JSON.stringify({ ...cur, ...patch, agentId }));
  } catch {
    /* best-effort; a disabled localStorage just loses cross-navigation memory */
  }
}
export function clearGuideProgress(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(GUIDE_PROGRESS_KEY);
  } catch {
    /* ignore */
  }
}

/** Arm the first-run SetupGuide for a freshly-registered agent, and scrub the
 *  PRIOR identity's per-machine state so it can't bleed into the new one. Call
 *  from EVERY fresh-registration site — the onboarding "New agent" button and
 *  both recovery-banner "New agent" paths (device-mismatch takeover, first-connect
 *  401). Without GUIDE_PENDING_KEY set, a replaced identity silently skips the
 *  guide; without the scrub, the new agent inherits the old one's pause (a spend
 *  decision that must NOT carry over) and stale cached policy/profile. No-op for a
 *  missing agentId (guards the pre-registration window). */
export function armFirstRunGuide(agentId: string | undefined): void {
  if (agentId === undefined || agentId === "") return;
  // In-memory mirrors from the replaced agent — reset so the dashboard doesn't
  // flash the old name/claim/usage/policy before the first refetch.
  cachedPolicy = null;
  cachedProfile = null;
  cachedRaw = null;
  cachedClaim = "unknown";
  cachedUsage = null;
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(GUIDE_PENDING_KEY, agentId);
    // Persisted cross-agent state — a new identity must start un-paused, with no
    // stale policy cache or a prior agent's half-finished guide progress.
    localStorage.removeItem(PAUSE_KEY);
    localStorage.removeItem(POLICY_CACHE_KEY);
    localStorage.removeItem(GUIDE_PROGRESS_KEY);
  } catch {
    /* best-effort; a disabled localStorage just loses the scrub */
  }
}

// In-app Terms/Privacy consent. The owner can read both documents (links open the
// public pages on the paired host) and accept right here — no browser round-trip.
// Acceptance posts through the agent key to the owner's own account; on success the
// parent re-reads the policy and this card disappears (termsPending flips false).
function TermsConsentCard({ policy, onAccepted }: { policy: AgentPolicy; onAccepted: () => void }) {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (!agreed || submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await acceptLegal();
    setSubmitting(false);
    if (res.ok) {
      setDone(true);
      onAccepted();
    } else {
      setError(t("play.terms.error"));
    }
  };

  return (
    <div className="v3-dv-card v3-dv-card--warn px-5 py-4">
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={18} className="v3-dv-warn mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-[var(--text)]">{t("play.terms.title")}</div>
          <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">{t("play.terms.body")}</div>
          {policy.currentTermsVersion !== undefined && policy.currentPrivacyVersion !== undefined && (
            <div className="mt-1 text-[11px] text-[var(--text-faint)]">
              {t("play.terms.versions", { terms: policy.currentTermsVersion, privacy: policy.currentPrivacyVersion })}
            </div>
          )}
          {done ? (
            <div className="v3-dv-ok mt-2 flex items-center gap-1.5 text-[12px]">
              <Check size={14} /> {t("play.terms.success")}
            </div>
          ) : (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                <button onClick={() => void openLegal("terms")} className="app-no-drag v3-dv-acc inline-flex items-center gap-1 text-[12px] hover:underline">
                  <ExternalLink size={12} /> {t("play.terms.viewTerms")}
                </button>
                <button onClick={() => void openLegal("privacy")} className="app-no-drag v3-dv-acc inline-flex items-center gap-1 text-[12px] hover:underline">
                  <ExternalLink size={12} /> {t("play.terms.viewPrivacy")}
                </button>
              </div>
              <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[12px] text-[var(--text)]">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
                <span>{t("play.terms.agree")}</span>
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void onConfirm()}
                  disabled={!agreed || submitting}
                  className="v3-dv-btn v3-dv-btn--primary"
                >
                  {submitting && <Loader2 size={13} className="animate-spin" />}
                  {submitting ? t("play.terms.submitting") : t("play.terms.confirm")}
                </button>
                <button onClick={() => void openDashboard()} className="text-[12px] text-[var(--text-faint)] hover:text-[var(--text-muted)]">
                  {t("play.terms.browserFallback")}
                </button>
              </div>
              {error !== null && <div className="v3-dv-err mt-2 text-[12px]">{error}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlayView({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const status = useBridgeStatus();
  const configured = status?.config !== undefined;
  // Bumping this forces a re-read of the guide-pending flag after finish/skip.
  const [guideTick, setGuideTick] = useState(0);
  void guideTick;
  const refresh = () => {
    void window.aifight?.getStatus();
  };
  if (!configured) return <Onboarding refresh={refresh} />;
  if (guidePendingFor(status?.config?.agentId)) {
    return (
      <SetupGuide
        onDone={() => {
          try {
            localStorage.removeItem(GUIDE_PENDING_KEY);
          } catch {
            /* ignore */
          }
          clearGuideProgress();
          setGuideTick((n) => n + 1);
        }}
        onNavigate={onNavigate}
        currentName={status?.config?.agentName ?? ""}
        agentId={status?.config?.agentId}
      />
    );
  }
  return <Dashboard status={status as BridgeStatus} refresh={refresh} onNavigate={onNavigate} />;
}

// ── Onboarding (unconfigured) ────────────────────────────────────────────────

function Onboarding({ refresh }: { refresh: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [logErr, setLogErr] = useState(false);

  // NOTE: setup/connect run with --json on purpose. Without it, `aifight setup`
  // falls through to its interactive wizard (LLM setup, "install service? [Y/n]")
  // that reads stdin — which, in the in-process CLI, blocks forever (the prompt
  // text is captured, not shown, and there is no TTY the user can answer on), so
  // the button just spins. --json returns right after the identity is written,
  // before any prompt.
  const run = async (
    id: string,
    op: CliOp,
    onOk?: (json: Record<string, unknown>) => string,
  ) => {
    setBusy(id);
    setLog("");
    setLogErr(false);
    const r = await runCli(op);
    setBusy(null);
    if (r.exitCode === 0) {
      setLog(onOk !== undefined && r.json !== undefined ? onOk(r.json as Record<string, unknown>) : resultText(r));
      // Bring the freshly registered/connected agent ONLINE immediately. Register
      // only writes the config; without this the agent sat "offline" until a manual
      // reconnect or the next app launch (D2). onStatus then flips the view forward.
      void bridgeStart().then(refresh);
    } else {
      setLog(localizeServerError(resultText(r)));
      setLogErr(true);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader eyebrow={t("eyebrow.play")} title={t("play.onboard.title")} subtitle={t("play.onboard.subtitle")} />

      <Section icon={UserPlus} title={t("play.onboard.newTitle")} hint={t("play.onboard.newHint")}>
        <Btn
          busy={busy === "register"}
          onClick={() =>
            run("register", { kind: "setup" }, (j) => {
              // A fresh registration → run the first-run guide next (keyed to
              // this agent so pairing an existing agent never triggers it), and
              // scrub any prior identity's per-machine state.
              const cfg = (j.config ?? {}) as { agentId?: string };
              armFirstRunGuide(cfg.agentId);
              // Don't dump the raw claim URL here — the setup guide's claim step
              // has a proper "open claim page" button. Just confirm registration.
              return t("play.onboard.registeredOk");
            })
          }
        >
          {t("play.onboard.newBtn")}
        </Btn>
      </Section>

      <Section icon={Link2} title={t("play.onboard.connectTitle")} hint={t("play.onboard.connectHint")}>
        <div className="flex w-full gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("play.onboard.codePlaceholder")}
            className="v3-dv-input min-w-0 flex-1"
          />
          <Btn
            busy={busy === "connect"}
            disabled={code.trim() === ""}
            onClick={() =>
              run("connect", { kind: "connect", code: code.trim() }, (j) => {
                const cfg = (j.config ?? {}) as { agentName?: string };
                return t("play.onboard.connectedOk", { name: cfg.agentName ?? "" });
              })
            }
          >
            {t("play.onboard.connectBtn")}
          </Btn>
        </div>
      </Section>

      {log !== "" && <ActionLog text={log} error={logErr} />}
    </div>
  );
}

// ── First-run setup guide (fresh registration) ──────────────────────────────
// One screen, a short todo list. Step 1 names the agent (a nice evocative name
// is pre-filled — the user keeps or changes it). Step 2 — the daily auto-match
// cap — is the load-bearing one: the agent plays ranked matches BY ITSELF, every
// match makes many model calls on the user's own API key, and a new user must
// choose that burn rate consciously (0 = manual only; >10/day needs confirm).

const CAP_PRESETS = [0, 2, 5] as const;

function SetupGuide({
  onDone,
  onNavigate,
  currentName,
  agentId,
}: {
  onDone: () => void;
  onNavigate?: (view: string) => void;
  currentName: string;
  agentId: string | undefined;
}) {
  const { t } = useTranslation();
  // Seed step state from persisted per-agent progress so navigating to Models
  // (step 3) and back doesn't wipe the steps already done. Read once on mount.
  const [progress0] = useState(() => readGuideProgress(agentId));
  const [cap, setCap] = useState(progress0?.cap ?? 2);
  const [custom, setCustom] = useState(progress0?.cap != null && ![0, 2, 5].includes(progress0.cap));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(progress0?.cap ?? null);
  const [error, setError] = useState("");
  // Step 1 — display name. Pre-filled with the auto-suggested evocative name.
  const [nameDraft, setNameDraft] = useState(currentName);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameApplied, setNameApplied] = useState(progress0?.nameDone ?? false);
  const [nameError, setNameError] = useState("");
  // Steps 3 (model) & 4 (claim) are "navigate away" actions, so reflect their
  // REAL completion instead of showing them perpetually undone. The guide
  // remounts on every return (step 3 opens Models), so a mount-time fetch keeps
  // them fresh — no persistence needed. Best-effort; default not-done.
  const [llmDone, setLlmDone] = useState(false);
  const [claimDone, setClaimDone] = useState(false);
  useEffect(() => {
    let alive = true;
    // "Done" = a model with a RESOLVABLE key — a config with a keyless profile
    // still can't play, so `configured` alone would be a false check.
    void getLLMConfig()
      .then((c) => {
        if (alive) setLlmDone(c.configured && c.profiles.some((p) => p.keyResolvable));
      })
      .catch(() => {});
    void runCli({ kind: "status" })
      .then((r) => {
        const pa = (r.json as { platformAgentStatus?: { isClaimed?: boolean } } | undefined)?.platformAgentStatus;
        if (alive && pa?.isClaimed === true) setClaimDone(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const applyName = async () => {
    const next = nameDraft.trim();
    // Keeping the suggested name needs no server round-trip — the agent already
    // has it; just mark the step done.
    if (next === "" || next === currentName) {
      setNameApplied(true);
      setNameError("");
      saveGuideProgress(agentId, { nameDone: true });
      return;
    }
    setNameBusy(true);
    setNameError("");
    const r = await setAgentName({ name: next });
    setNameBusy(false);
    if (r.ok) {
      setNameApplied(true);
      saveGuideProgress(agentId, { nameDone: true });
    } else {
      setNameError(r.error ?? t("play.rename.failed"));
    }
  };

  const apply = async (value: number) => {
    setBusy(true);
    setError("");
    const r = await setAgentPolicy({ maxGamesPerDay: value });
    setBusy(false);
    setConfirming(false);
    if (r.ok) {
      setApplied(value);
      saveGuideProgress(agentId, { cap: value });
      const p = await getAgentPolicy();
      if (p !== null) rememberPolicy(p);
      // cap>0 → enter the auto-match pool now. The first queue join must come from
      // the client (the server requeues thereafter); without this a freshly set-up
      // agent wouldn't auto-play until the next launch. No-op when offline / cap 0.
      if (value > 0) await setMatchingPaused(false);
    } else {
      setError(localizeServerError(r.error, "policy"));
    }
  };

  const onApplyClick = () => {
    if (capNeedsConfirm(cap)) setConfirming(true);
    else void apply(cap);
  };

  const presetBtn = (value: number, label: string, sub: string) => {
    const active = !custom && cap === value;
    return (
      <button
        key={value}
        onClick={() => {
          setCustom(false);
          setCap(value);
          setConfirming(false);
          setApplied(null);
          setError("");
        }}
        className={"v3-dv-preset" + (active ? " on" : "")}
      >
        <div className={"font-mono text-[20px] font-semibold tabular-nums " + (active ? "text-[var(--v3-acc-deep)]" : "text-[var(--text)]")}>
          {label}
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{sub}</div>
      </button>
    );
  };

  // Numbered step marker: a filled circle with the step number that flips to a
  // green check once the step is done. Gives the guide an explicit "do these in
  // order" shape instead of four look-alike cards.
  const stepBadge = (num: number, done: boolean) => (
    <div className={"v3-dv-stepbadge" + (done ? " v3-dv-stepbadge--done" : "")} aria-hidden>
      {done ? <Check size={13} /> : num}
    </div>
  );

  // The daily-cap choice is the load-bearing one — until the user has consciously
  // applied a cap, the primary "enter" button stays locked so they can't sail past
  // it and silently inherit the server default.
  const capChosen = applied !== null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader eyebrow={t("guide.eyebrow")} title={t("guide.title")} subtitle={t("guide.subtitle")} />

      {/* Step 1 — name your agent (a nice name is pre-filled; keep or change it) */}
      <div className="v3-dv-card px-5 py-4">
        <div className="flex items-start gap-2.5">
          {stepBadge(1, nameApplied)}
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-[var(--text)]">{t("guide.nameTitle")}</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">{t("guide.nameBody")}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={nameDraft}
                maxLength={50}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  setNameApplied(false);
                  setNameError("");
                }}
                className="v3-dv-input w-56 text-[14px]"
              />
              <Btn busy={nameBusy} disabled={nameApplied || nameDraft.trim() === ""} onClick={() => void applyName()}>
                {nameApplied ? t("guide.nameAppliedBtn") : t("guide.nameApplyBtn")}
              </Btn>
              {nameApplied && (
                <span className="v3-dv-ok flex items-center gap-1 text-[12px]">
                  <Check size={13} />
                  {t("guide.nameApplied", { name: nameDraft.trim() })}
                </span>
              )}
              {nameError !== "" && <span className="v3-dv-err text-[12px]">{nameError}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Step 2 — the daily auto-match cap (the core of the guide) */}
      <div className="v3-dv-card px-5 py-4">
        <div className="flex items-start gap-2.5">
          {stepBadge(2, capChosen)}
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-[var(--text)]">{t("guide.capTitle")}</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">{t("guide.capBody")}</p>

            <div className="mt-3 flex flex-wrap gap-2">
              {presetBtn(0, t("guide.capManualLabel"), t("guide.capManualSub"))}
              {presetBtn(2, "2", t("guide.capDefaultSub"))}
              {presetBtn(5, "5", t("guide.capFiveSub"))}
              <button
                onClick={() => {
                  setCustom(true);
                  setConfirming(false);
                  setApplied(null);
                  setError("");
                }}
                className={"v3-dv-preset" + (custom ? " on" : "")}
              >
                <div className={"font-mono text-[20px] font-semibold " + (custom ? "text-[var(--v3-acc-deep)]" : "text-[var(--text)]")}>
                  {custom ? cap : "…"}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{t("guide.capCustomSub")}</div>
              </button>
            </div>

            {custom && (
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={CAP_MAX}
                  value={cap}
                  onChange={(e) => {
                    setCap(e.target.value === "" ? 0 : clampInt(Number(e.target.value), 0, CAP_MAX));
                    setConfirming(false);
                    setApplied(null);
                    setError("");
                  }}
                  className="v3-dv-input w-24 tabular-nums"
                />
                <span className="text-[12px] text-[var(--text-muted)]">{t("play.auto.capUnit")}</span>
              </div>
            )}

            {confirming ? (
              <div className="v3-dv-card v3-dv-card--warn mt-3 px-3.5 py-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={15} className="v3-dv-warn mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-[var(--text)]">{t("guide.capConfirmTitle", { n: cap })}</div>
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">{t("guide.capConfirmBody")}</div>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void apply(cap)}
                        disabled={busy}
                        className="v3-dv-btn v3-dv-btn--primary v3-dv-btn--sm"
                      >
                        {busy && <Loader2 size={12} className="animate-spin" />}
                        {t("guide.capConfirmBtn", { n: cap })}
                      </button>
                      <button
                        onClick={() => setConfirming(false)}
                        className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Btn busy={busy} disabled={applied === cap} onClick={onApplyClick}>
                  {applied === cap ? t("guide.capAppliedBtn") : t("guide.capApplyBtn")}
                </Btn>
                {applied === cap && (
                  <span className="v3-dv-ok flex items-center gap-1 text-[12px]">
                    <Check size={13} />
                    {cap === 0 ? t("guide.capAppliedManual") : t("guide.capApplied", { n: cap })}
                  </span>
                )}
                {error !== "" && <span className="v3-dv-err text-[12px]">{error}</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Step 2 — connect the LLM key */}
      <div className="v3-dv-card flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          {stepBadge(3, llmDone)}
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-[var(--text)]">{t("guide.llmTitle")}</div>
            <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">{t("guide.llmBody")}</div>
          </div>
        </div>
        <button onClick={() => onNavigate?.("models")} className="v3-dv-btn v3-dv-btn--ghost shrink-0">
          <Cpu size={13} />
          {t("guide.llmBtn")}
        </button>
      </div>

      {/* Step 3 — claim the agent */}
      <div className="v3-dv-card flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start gap-2.5">
          {stepBadge(4, claimDone)}
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-[var(--text)]">{t("guide.claimTitle")}</div>
            <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">{t("guide.claimBody")}</div>
          </div>
        </div>
        <button onClick={() => void openClaim()} className="v3-dv-btn v3-dv-btn--ghost shrink-0">
          <ExternalLink size={13} />
          {t("guide.claimBtn")}
        </button>
      </div>

      <div className="pt-1">
        {!capChosen && (
          <div className="v3-dv-warn mb-2 flex items-center justify-end gap-1.5 text-[11.5px]">
            <AlertTriangle size={13} className="shrink-0" />
            {t("guide.enterLockedHint")}
          </div>
        )}
        <div className="flex items-center justify-between">
          <button onClick={onDone} className="text-[12px] text-[var(--text-faint)] hover:text-[var(--text-muted)]">
            {t("guide.skip")}
          </button>
          <button
            onClick={onDone}
            disabled={!capChosen}
            title={!capChosen ? t("guide.enterLockedHint") : undefined}
            className="v3-dv-btn v3-dv-btn--primary px-5 py-2.5"
          >
            {t("guide.enter")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Dashboard (configured) ───────────────────────────────────────────────────

interface SessionRow {
  session_id: string;
  game?: string;
  status?: string;
  result_label?: string;
  updated_at?: string;
  decision_count?: number;
  /** Seats in the match (whole-match roster, runtime summary). */
  player_count?: number;
  /** Whole-match interaction count, every player's moves included. */
  event_count?: number;
  replay_url?: string;
}

function Dashboard({ status, refresh, onNavigate }: { status: BridgeStatus; refresh: () => void; onNavigate?: (view: string) => void }) {
  const { t, i18n } = useTranslation();
  const cfg = status.config!;
  const origin = webOrigin(cfg.baseUrl);
  const phase = status.phase;
  const connected = phase === "running";
  const connecting = phase === "starting";
  const live = useLiveStore();
  const games = useLiveGames();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Inline display-name rename (pencil next to the hero name). Draft + edit flag.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [paused, setPaused] = useState(readPersistedPause); // persisted across launches (spend safety)
  // One game selector drives BOTH play-now and create-challenge (D5 — they used
  // to have two identical pickers).
  const [game, setGame] = useState<string>(() => games[0] ?? "texas_holdem");
  const [acceptUrl, setAcceptUrl] = useState("");
  // Transient "已排队…" flash after a manual match request — gives in-flight
  // feedback and briefly disables the button so a user can't double-request.
  const [matchFlash, setMatchFlash] = useState(false);
  useEffect(() => {
    if (games.length === 0) return;
    if (!games.includes(game)) setGame(games[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games]);
  const [claim, setClaim] = useState<ClaimState>(() => cachedClaim);
  const [publicName, setPublicName] = useState<string | null>(() => cachedProfile?.name ?? null);
  const [stats, setStats] = useState<AgentStats | null>(() => cachedProfile?.stats ?? null);
  const [policy, setPolicyState] = useState<AgentPolicy | null>(() => cachedPolicy);
  const [day, setDay] = useState<number>(() => cachedPolicy?.maxGamesPerDay ?? 2);
  // >10/day needs a second, explicit confirmation (same rule as the setup guide + CLI).
  const [capConfirming, setCapConfirming] = useState(false);
  const policyLoaded = useRef(false);
  const [raw, setRaw] = useState<AgentProfile | null>(() => cachedRaw);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [usage, setUsage] = useState<UsageOverview | null>(() => cachedUsage);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [challenges, setChallenges] = useState<CreatedChallenge[]>([]);

  const loadPolicy = (resetForm: boolean) => {
    void getAgentPolicy().then((p) => {
      if (p === null) return;
      setPolicyState(p);
      rememberPolicy(p);
      if (resetForm || !policyLoaded.current) {
        setDay(p.maxGamesPerDay);
        policyLoaded.current = true;
      }
    });
  };
  const loadProfile = () => {
    void getAgentProfile().then((pr) => {
      setPublicName(pr.name);
      setStats(pr.stats);
      cachedProfile = pr;
    });
    void getOwnProfileRaw().then((j) => {
      const p = (j as AgentProfile | null) ?? null;
      setRaw(p);
      cachedRaw = p;
    });
  };
  const loadUsage = () => {
    void getUsageOverview().then((u) => {
      if (u !== null) {
        setUsage(u);
        cachedUsage = u;
      }
    });
  };
  const loadSessions = () => {
    void runCli({ kind: "sessionsList" }).then((r) => {
      const list = (r.json as { sessions?: unknown } | undefined)?.sessions;
      setSessions(Array.isArray(list) ? (list as SessionRow[]).slice(0, 10) : []);
    });
  };
  const checkClaim = () => {
    void runCli({ kind: "status" }).then((r) => {
      const pa = (r.json as { platformAgentStatus?: { kind: string; isClaimed?: boolean } } | undefined)?.platformAgentStatus;
      if (pa?.kind === "ok") {
        const next: ClaimState = pa.isClaimed ? "claimed" : "unclaimed";
        setClaim(next);
        cachedClaim = next;
      }
    });
    loadProfile();
    loadPolicy(false);
    loadUsage();
    loadSessions();
  };
  useEffect(checkClaim, []);

  // Re-apply a PERSISTED pause once the bridge is online. main auto-joins the
  // matchmaking pool on every launch (token-burn safety lives in the cap), so a
  // user who paused yesterday would otherwise have spend silently resume today.
  // Fires once per session, after `connected` first turns true.
  const pauseReapplied = useRef(false);
  useEffect(() => {
    if (connected && paused && !pauseReapplied.current) {
      pauseReapplied.current = true;
      void setMatchingPaused(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // When a match ends, refresh today's count, record, usage and recent list so
  // the dashboard reflects the just-finished game without a manual reload.
  const prevFinished = useRef(false);
  const [radarRefresh, setRadarRefresh] = useState(0);
  useEffect(() => {
    if (live.match.finished && !prevFinished.current) {
      loadPolicy(false);
      loadProfile();
      loadUsage();
      loadSessions();
      setRadarRefresh((n) => n + 1); // style radar re-pulls after each own match (§6.3)
    }
    prevFinished.current = live.match.finished;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.match.finished]);

  // Prefer the server-authoritative name (status → policy.name) so a rename from
  // any device shows here; fall back to the public profile name, then the local
  // cached name. publicNo is the immutable numeric ID rendered next to it.
  const displayName = policy?.name ?? publicName ?? cfg.agentName;
  const publicNoLabel = formatPublicNo(policy?.publicNo);
  const history = raw?.rating_history ?? [];
  const ratings = raw?.ratings ?? [];
  const achievements = raw?.achievements ?? [];
  const model = raw?.agent?.model ?? null;
  const avatarUrl = raw?.agent?.avatar_url ?? null;
  const avatarPreset = raw?.agent?.avatar_preset ?? null;
  const policyDirty = policy !== null && day !== policy.maxGamesPerDay;
  const cap = policy?.maxGamesPerDay ?? 0;
  const gamesToday = policy?.gamesToday;
  const inMatch = live.match.sessionId !== null && !live.match.finished;
  const activity: Activity = !connected
    ? "offline"
    : inMatch
      ? "in_match"
      : paused
        ? "paused"
        : cap > 0 && gamesToday !== undefined && gamesToday >= cap
          ? "resting"
          : cap <= 0
            ? "idle"
            : "matching";
  const division = divisionOf(stats?.rating ?? null, stats?.totalGames ?? 0);

  // Ranked-progress hint — explains WHY this agent isn't on the leaderboard yet,
  // closing the gap the "claimed" chip + "provisional" division leave ambiguous
  // (a claimed-but-unnamed agent looks fine yet literally cannot enter ranked).
  // Pure logic lives in computeRankedHint; here we just map kind → localized copy.
  const hint = computeRankedHint(raw?.agent, raw?.summary, `${origin}/dashboard`);
  const rankedHint: { tone: "warn" | "info"; text: string; href?: string; cta?: string } | null =
    hint === null
      ? null
      : hint.kind === "gamesNeeded"
        ? { tone: "info", text: t("play.ranked.gamesNeeded", { count: hint.count }) }
        : {
            tone: "warn",
            text: t("play.ranked.needClaim"),
            href: hint.href,
            cta: t("play.ranked.openDashboard"),
          };

  const retry = async () => {
    setBusy("retry");
    await bridgeStart();
    await setMatchingPaused(paused);
    setBusy(null);
    refresh();
  };

  // Write the daily cap to the SERVER (source of truth; last-write-wins), then
  // re-read it and reconcile our place in the matchmaking pool. >threshold goes
  // through an explicit confirmation step first.
  const applyPolicy = async () => {
    const d = clampInt(day, 0, CAP_MAX);
    setDay(d);
    setCapConfirming(false);
    setBusy("policy");
    const r = await setAgentPolicy({ maxGamesPerDay: d });
    if (r.ok) {
      const p = await getAgentPolicy();
      if (p !== null) {
        setPolicyState(p);
        setDay(p.maxGamesPerDay);
        rememberPolicy(p);
      }
      await setMatchingPaused(paused);
      setFeedback({ tone: "ok", text: d === 0 ? t("play.auto.disabled") : t("play.auto.applied", { n: d }) });
    } else {
      setFeedback({ tone: "err", text: localizeServerError(r.error, "policy") });
    }
    setBusy(null);
  };

  const onApplyPolicyClick = () => {
    if (capNeedsConfirm(clampInt(day, 0, CAP_MAX))) setCapConfirming(true);
    else void applyPolicy();
  };

  // Change the free-form display name via the agent-key endpoint (server is the
  // source of truth; it enforces the rename cooldown + reserved/profanity rules).
  // On success we re-read the profile + policy so the hero reflects the new name
  // and numeric ID immediately.
  const applyRename = async () => {
    const next = nameDraft.trim();
    if (next === "" || next === displayName) {
      setEditingName(false);
      return;
    }
    setBusy("rename");
    const r = await setAgentName({ name: next });
    if (r.ok) {
      setEditingName(false);
      loadProfile();
      loadPolicy(false);
      setFeedback({ tone: "ok", text: t("play.rename.applied", { name: r.name ?? next }) });
    } else {
      // Surface the server message (cooldown / reserved / profanity) verbatim.
      setFeedback({ tone: "err", text: r.error ?? t("play.rename.failed") });
    }
    setBusy(null);
  };

  const togglePause = async () => {
    const next = !paused;
    setPaused(next);
    try {
      localStorage.setItem(PAUSE_KEY, next ? "1" : "0");
    } catch {
      /* ignore quota errors */
    }
    setBusy("pause");
    await setMatchingPaused(next);
    setBusy(null);
  };

  const doChallenge = async () => {
    setBusy("challenge");
    setFeedback(null);
    const r = await runCli({ kind: "challenge", game });
    setBusy(null);
    const url = (r.json as { join_url?: string } | undefined)?.join_url;
    if (typeof url === "string" && url.length > 0) {
      setChallenges((cs) => [{ game, url }, ...cs.filter((c) => c.url !== url)].slice(0, 8));
    } else {
      const raw = resultText(r);
      setFeedback({ tone: "err", text: localizeServerError(raw, "challengeCreate"), action: isClaimNameError(raw) ? "claim" : undefined });
    }
  };

  const doAccept = async () => {
    setBusy("accept");
    setFeedback(null);
    const r = await runCli({ kind: "accept", url: acceptUrl.trim() });
    setBusy(null);
    if (r.exitCode === 0 && r.error === undefined) {
      setFeedback({ tone: "ok", text: t("play.accept.ok") });
    } else {
      const raw = resultText(r);
      setFeedback({ tone: "err", text: localizeServerError(raw, "challengeAccept"), action: isClaimNameError(raw) ? "claim" : undefined });
    }
  };

  const doRequest = async () => {
    setBusy("match");
    setFeedback(null);
    const r = await requestMatches(game, 1);
    setBusy(null);
    if (r.ok) {
      // Inline transient feedback + brief disable (via matchFlash in the button
      // row) instead of the bottom bar. requestMatches is fire-and-forget — the
      // local queue join is dispatched and the server matches at its own pace —
      // so this reports "queued", not a guaranteed match.
      setMatchFlash(true);
      window.setTimeout(() => setMatchFlash(false), 4000);
    } else {
      setFeedback({ tone: "err", text: localizeServerError(r.error, "matchRequest") });
    }
  };

  const doClaim = async () => {
    setBusy("claim");
    await openClaim();
    setBusy(null);
  };

  const monthTotal = usage?.month.total;
  const monthTokens = monthTotal !== undefined ? monthTotal.inputTokens + monthTotal.outputTokens : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {/* Claim banner — an agent must be claimed before it can play ranked. */}
      {claim === "unclaimed" && (
        <div className="v3-dv-card v3-dv-card--warn px-5 py-4">
          <div className="flex items-start gap-2.5">
            <ShieldAlert size={18} className="v3-dv-warn mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-[var(--text)]">{t("play.claim.title")}</div>
              <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">{t("play.claim.body")}</div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={doClaim}
                  disabled={busy === "claim"}
                  className="v3-dv-btn v3-dv-btn--primary"
                >
                  {busy === "claim" ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                  {t("play.claim.btn")}
                </button>
                <button
                  onClick={checkClaim}
                  className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm"
                >
                  {t("play.claim.recheck")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Terms — the claimed owner must accept the current Terms/Privacy. Accepted
          in-app (no browser): read the linked docs, tick the box, confirm. */}
      {policy?.termsPending === true && (
        <TermsConsentCard
          policy={policy}
          onAccepted={() => {
            void getAgentPolicy().then((p) => {
              if (p !== null) setPolicyState(p);
            });
          }}
        />
      )}

      {/* ── Hero: identity + live activity ── */}
      <div className="v3-dv-card px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <button
              type="button"
              onClick={() => setAvatarOpen((v) => !v)}
              title={t("play.avatar.set")}
              className="app-no-drag"
              style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", borderRadius: 12, lineHeight: 0 }}
            >
              <AgentAvatar name={displayName} agentId={cfg.agentId} avatarUrl={avatarUrl} preset={avatarPreset} size={48} elevated />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {editingName ? (
                  <div className="app-no-drag flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={nameDraft}
                      maxLength={50}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void applyRename();
                        else if (e.key === "Escape") setEditingName(false);
                      }}
                      className="v3-dv-input v3-dv-display w-44 px-2 py-1 text-[16px]"
                    />
                    <button
                      onClick={() => void applyRename()}
                      disabled={busy === "rename"}
                      title={t("common.apply")}
                      className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--v3-acc-deep)] disabled:opacity-60"
                    >
                      {busy === "rename" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    </button>
                    <button
                      onClick={() => setEditingName(false)}
                      title={t("common.cancel")}
                      className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="v3-dv-display truncate text-[20px] leading-tight text-[var(--text)]">{displayName}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setNameDraft(displayName);
                        setEditingName(true);
                        setFeedback(null);
                      }}
                      title={t("play.rename.edit")}
                      className="app-no-drag rounded-md p-0.5 text-[var(--text-faint)] hover:text-[var(--v3-acc-deep)]"
                    >
                      <Pencil size={13} />
                    </button>
                  </>
                )}
                {publicNoLabel !== "" && (
                  <span className="font-mono text-[11px] tabular-nums text-[var(--text-faint)]" title={t("play.rename.idTip")}>
                    #{publicNoLabel}
                  </span>
                )}
                <Chip tone={claim === "claimed" ? "ok" : "neutral"}>
                  {claim === "claimed" ? t("home.hero.claimed") : t("home.hero.unclaimed")}
                </Chip>
                <Chip tone="accent">{t(`home.division.${division}`)}</Chip>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                {model !== null && model !== "" && (
                  <span className="flex items-center gap-1">
                    <Cpu size={11} />
                    {model}
                  </span>
                )}
                <span className="text-[var(--text-faint)]">{cfg.runtimeType} · {origin.replace(/^https?:\/\//, "")}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ActivityPill activity={activity} connecting={connecting} />
            {!connected && !connecting && (
              <button
                onClick={retry}
                disabled={busy === "retry"}
                className="v3-dv-btn v3-dv-btn--primary v3-dv-btn--sm"
              >
                {busy === "retry" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {t("play.status.retry")}
              </button>
            )}
            <QuickLink href={origin} icon={Globe}>{t("play.links.site")}</QuickLink>
            <QuickLink onClick={() => void openDashboard()} icon={LayoutDashboard}>{t("play.links.dashboard")}</QuickLink>
          </div>
        </div>
        {avatarOpen && (
          <div className="mt-4 border-t border-[var(--v3-hairline)] pt-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="v3-dv-display text-[15px] text-[var(--text)]">{t("play.avatar.title")}</span>
              <button
                type="button"
                onClick={() => setAvatarOpen(false)}
                className="font-mono text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                {t("play.avatar.close")}
              </button>
            </div>
            <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t("play.avatar.hint")}</p>
            <AvatarPicker
              agentId={cfg.agentId ?? "agent"}
              name={displayName}
              avatarUrl={avatarUrl}
              preset={avatarPreset}
              actions={desktopAvatarActions()}
              onChanged={loadProfile}
            />
          </div>
        )}
      </div>

      {/* ── KPI strip ── */}
      <div className="v3-dv-kpis">
        <Kpi icon={Gauge} label={t("play.stats.rating")} value={stats?.rating != null ? String(stats.rating) : "—"} accent />
        <Kpi icon={Trophy} label={t("play.stats.rank")} value={stats?.rank != null ? `#${stats.rank}` : "—"} accent />
        <Kpi
          icon={Swords}
          label={t("home.kpi.record")}
          value={stats !== null ? `${stats.wins}-${stats.losses}-${stats.draws}` : "—"}
          sub={stats !== null ? t("home.kpi.gamesSub", { n: stats.totalGames }) : undefined}
        />
        <Kpi
          icon={Percent}
          label={t("play.stats.winRate")}
          value={stats !== null && stats.totalGames > 0 ? `${Math.round(stats.winRate * 100)}%` : "—"}
        />
        <Kpi
          icon={Zap}
          label={t("home.kpi.todayAuto")}
          value={cap <= 0 ? t("home.kpi.manualOnly") : `${gamesToday ?? "—"}/${cap}`}
        />
        <Kpi
          icon={Coins}
          label={t("home.kpi.monthTokens")}
          value={monthTokens !== null && (usage?.month.total.calls ?? 0) > 0 ? formatTokens(monthTokens) : "—"}
          sub={
            usage !== null && usage.hasPrices && usage.month.total.estimatedCost !== undefined
              ? `≈ ${usage.currency}${usage.month.total.estimatedCost.toFixed(2)}`
              : undefined
          }
        />
      </div>

      {/* ── Ranked-progress hint (only renders when not yet on the leaderboard) ── */}
      {rankedHint !== null && (
        <div
          className={
            "v3-dv-card flex flex-wrap items-center justify-between gap-3 px-5 py-3" +
            (rankedHint.tone === "warn" ? " v3-dv-card--warn" : "")
          }
        >
          <div className="flex items-start gap-2 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {rankedHint.tone === "warn" ? (
              <AlertTriangle size={15} className="v3-dv-warn mt-0.5 shrink-0" />
            ) : (
              <Trophy size={15} className="mt-0.5 shrink-0 text-[var(--text-faint)]" />
            )}
            <span>{rankedHint.text}</span>
          </div>
          {rankedHint.href !== undefined && rankedHint.cta !== undefined && (
            <QuickLink onClick={() => void openDashboard()} icon={LayoutDashboard}>
              {rankedHint.cta}
            </QuickLink>
          )}
        </div>
      )}

      {/* ── Main area (owner column order, 2026-07-02): one grid, two flex
             columns. Left (2/3): per-game → rating trend → recent matches →
             achievements. Right (1/3): style radar → auto-match → battle →
             token usage. flex-1 sits on recent matches (left) and the battle
             card (right) so both columns close on the same bottom edge. ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {ratings.length > 0 && (
            <div className="v3-dv-card px-5 py-4">
              <div className="v3-dv-hd mb-3">{t("home.perGame")}</div>
              <PerGameCards ratings={ratings} />
            </div>
          )}
          <div className="v3-dv-card px-5 py-4">
            <div className="v3-dv-hd mb-3">{t("home.ratingTrend")}</div>
            <RatingChart history={history} />
          </div>

          {/* Recent matches — a row click opens THAT match's replay in the
              Watch tab (owner ruling: a click means "show me the details";
              the History tab stays one click away via 查看全部). */}
          <div className="v3-dv-card flex flex-1 flex-col px-5 py-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="v3-dv-hd">{t("home.recent.title")}</span>
              <button
                onClick={() => onNavigate?.("history")}
                className="text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                {t("home.recent.viewAll")} →
              </button>
            </div>
            {sessions === null ? (
              <div className="flex flex-1 items-center justify-center py-3 text-[12px] text-[var(--text-faint)]">…</div>
            ) : sessions.length === 0 ? (
              <div className="flex flex-1 items-center justify-center py-3 text-[12px] text-[var(--text-faint)]">{t("home.recent.empty")}</div>
            ) : (
              <div>
                {sessions.map((s) => (
                  <button
                    key={s.session_id}
                    onClick={() => {
                      setWatchReplayIntent({
                        sessionId: s.session_id,
                        game: s.game,
                        resultLabel: s.result_label,
                        replayUrl: s.replay_url,
                      });
                      onNavigate?.("watch");
                    }}
                    title={t("home.recent.openReplay")}
                    className="v3-dv-row v3-dv-row--flush"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ResultDot label={s.result_label} />
                      <span className="text-[13px] text-[var(--text)]">{gameLabel(s.game ?? "")}</span>
                      {s.result_label && <ResultChip label={s.result_label} t={t} />}
                    </div>
                    <div className="flex shrink-0 items-center gap-3 font-mono text-[11px] text-[var(--text-muted)]">
                      {typeof s.player_count === "number" && s.player_count > 1 && (
                        <span>{t("home.recent.players", { n: s.player_count })}</span>
                      )}
                      {typeof s.event_count === "number" && s.event_count > 0 && (
                        <span>{t("home.recent.interactions", { n: s.event_count })}</span>
                      )}
                      {typeof s.decision_count === "number" && (
                        <span>{t("home.recent.decisions", { n: s.decision_count })}</span>
                      )}
                      <span>{fmtTimePoint(s.updated_at, i18n.language)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Verified profile badges — anchors the column under match history;
              renders an empty state for new agents. */}
          <AchievementShelf achievements={achievements} />
        </div>

        <div className="flex flex-col gap-4">
          {/* Battle-style radar (§6.3): self-hiding — old server / switch off /
              fetch error render nothing (the column simply starts at auto-match). */}
          <StyleRadarCard
            games={games}
            refreshSignal={radarRefresh}
            onPlayCta={() => {
              document.getElementById("play-quick-actions")?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            t={t}
          />

          {/* Auto-match control */}
          <div className="v3-dv-card px-5 py-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="v3-dv-hd">{t("play.auto.title")}</span>
              <button
                onClick={togglePause}
                disabled={!connected || busy === "pause"}
                className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--xs"
              >
                {paused ? <Play size={12} /> : <Pause size={12} />}
                {paused ? t("play.auto.resume") : t("play.auto.pause")}
              </button>
            </div>

            <div className="flex items-center gap-4">
              <ProgressRing value={cap > 0 ? Math.min(1, (gamesToday ?? 0) / cap) : 0} idle={cap <= 0}>
                {cap <= 0 ? (
                  <span className="font-mono text-[10px] uppercase text-[var(--text-muted)]">{t("home.kpi.manualOnly")}</span>
                ) : (
                  <span className="font-mono text-[15px] font-semibold tabular-nums text-[var(--text)]">
                    {gamesToday ?? "—"}<span className="text-[var(--text-faint)]">/{cap}</span>
                  </span>
                )}
              </ProgressRing>
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                  {cap <= 0 ? t("play.auto.capOff") : t("home.auto.ringHint")}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={CAP_MAX}
                    value={day}
                    onChange={(e) => {
                      setDay(e.target.value === "" ? 0 : clampInt(Number(e.target.value), 0, CAP_MAX));
                      setCapConfirming(false);
                    }}
                    className="v3-dv-input w-16 px-2 py-1.5 tabular-nums"
                  />
                  <span className="text-[11px] text-[var(--text-muted)]">{t("play.auto.capUnit")}</span>
                  <Btn busy={busy === "policy"} disabled={!policyDirty} onClick={onApplyPolicyClick}>
                    {t("common.apply")}
                  </Btn>
                </div>
              </div>
            </div>

            {capConfirming && (
              <div className="v3-dv-card v3-dv-card--warn mt-3 px-3.5 py-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={15} className="v3-dv-warn mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-[var(--text)]">{t("guide.capConfirmTitle", { n: clampInt(day, 0, CAP_MAX) })}</div>
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">{t("guide.capConfirmBody")}</div>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void applyPolicy()}
                        disabled={busy === "policy"}
                        className="v3-dv-btn v3-dv-btn--primary v3-dv-btn--sm"
                      >
                        {busy === "policy" && <Loader2 size={12} className="animate-spin" />}
                        {t("guide.capConfirmBtn", { n: clampInt(day, 0, CAP_MAX) })}
                      </button>
                      <button
                        onClick={() => setCapConfirming(false)}
                        className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Quick actions: one game selector → play now / create challenge; then accept */}
          <div id="play-quick-actions" className="v3-dv-card flex-1 space-y-4 px-5 py-4">
            <div>
              <div className="v3-dv-hd mb-2">{t("play.actions.title")}</div>
              <GamePicker value={game} onChange={setGame} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Btn busy={busy === "match"} disabled={!connected || matchFlash} onClick={doRequest}>
                  {t("play.match.btn")}
                </Btn>
                <Btn busy={busy === "challenge"} disabled={!connected} onClick={doChallenge}>
                  {t("play.challenge.btn")}
                </Btn>
                {matchFlash && (
                  <span className="v3-dv-ok flex items-center gap-1 text-[11px] font-medium">
                    <Check size={12} /> {t("play.match.queued")}
                  </span>
                )}
              </div>
              <div className="mt-2 space-y-0.5 text-[10.5px] leading-snug text-[var(--text-faint)]">
                <div>· {t("play.match.hint")}</div>
                <div>· {t("play.challenge.hint")}</div>
              </div>
              {challenges.length > 0 && (
                <div className="mt-3 space-y-2 border-t border-[var(--v3-hairline)] pt-3">
                  {challenges.map((c) => (
                    <div key={c.url}>
                      <div className="mb-1 flex items-center gap-2 text-[11px]">
                        <span className="font-medium text-[var(--text)]">{gameLabel(c.game)}</span>
                        <span className="v3-dv-chip" data-tone="accent">
                          <i className="dot pulse" />
                          {t("home.challengeWaiting")}
                        </span>
                      </div>
                      <CopyRow text={c.url} />
                    </div>
                  ))}
                  <p className="text-[10.5px] text-[var(--text-faint)]">{t("home.challengeAccepted")}</p>
                </div>
              )}
            </div>

            <div className="border-t border-[var(--v3-hairline)] pt-3.5">
              <div className="v3-dv-hd mb-2">{t("play.accept.title")}</div>
              <div className="flex w-full gap-2">
                <input
                  value={acceptUrl}
                  onChange={(e) => setAcceptUrl(e.target.value)}
                  placeholder={t("play.accept.placeholder")}
                  className="v3-dv-input min-w-0 flex-1"
                />
                <Btn busy={busy === "accept"} disabled={!connected || acceptUrl.trim() === ""} onClick={doAccept}>
                  {t("play.accept.btn")}
                </Btn>
              </div>
            </div>
          </div>

          {/* Local token usage (§7A) */}
          <div className="v3-dv-card px-5 py-4">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <span className="v3-dv-hd">{t("home.usage.title")}</span>
              {usage !== null && usage.hasPrices && usage.month.total.estimatedCost !== undefined && (
                <span className="font-mono text-[12px] tabular-nums text-[var(--v3-acc-deep)]">
                  ≈ {usage.currency}{usage.month.total.estimatedCost.toFixed(2)}
                </span>
              )}
            </div>
            {usage === null || usage.month.total.calls === 0 ? (
              <div className="py-2 text-[12px] text-[var(--text-faint)]">{t("home.usage.empty")}</div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <UsageMini label={t("home.usage.month")} tokens={usage.month.total.inputTokens + usage.month.total.outputTokens} calls={usage.month.total.calls} t={t} />
                  <UsageMini label={t("home.usage.today")} tokens={usage.today.total.inputTokens + usage.today.total.outputTokens} calls={usage.today.total.calls} t={t} />
                </div>
                {usage.month.byModel.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {usage.month.byModel.slice(0, 3).map((m) => {
                      const total = usage.month.total.inputTokens + usage.month.total.outputTokens;
                      const mine = m.inputTokens + m.outputTokens;
                      const pct = total > 0 ? Math.max(2, Math.round((mine / total) * 100)) : 0;
                      return (
                        <div key={m.key}>
                          <div className="flex items-center justify-between font-mono text-[10.5px] text-[var(--text-muted)]">
                            <span className="truncate">{m.key}</span>
                            <span className="tabular-nums">{formatTokens(mine)}</span>
                          </div>
                          <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-[var(--color-deep)]">
                            <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="mt-2.5 text-[10.5px] leading-relaxed text-[var(--text-faint)]">
                  {usage.hasPrices ? t("home.usage.localNote") : t("home.usage.noPrices")}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {feedback !== null && <FeedbackBar feedback={feedback} onClaim={doClaim} />}
    </div>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────

/** Bottom-of-dashboard feedback: red when an action failed, neutral on success.
 *  When the failure is the claim/official-name gate, it carries a "set the name"
 *  button straight to the claim page (D4) — so the user isn't left with a dead-end
 *  error at challenge/accept time. */
function FeedbackBar({ feedback, onClaim }: { feedback: NonNullable<Feedback>; onClaim: () => void }) {
  const { t } = useTranslation();
  const err = feedback.tone === "err";
  return (
    <div className={"v3-dv-banner" + (err ? " v3-dv-err" : "")} data-tone={err ? "err" : "neutral"}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">{feedback.text}</span>
        {feedback.action === "claim" && (
          <button onClick={onClaim} className="v3-dv-btn v3-dv-btn--primary v3-dv-btn--xs shrink-0">
            <ExternalLink size={12} />
            {t("errors.needClaimAction")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Absolute time point for the recent-matches rows (owner ruling over the old
 *  relative "2h ago"): today → HH:mm, this year → MM-DD HH:mm, else full date.
 *  `now` is injectable for tests. */
export function fmtTimePoint(iso: string | undefined, locale: string, now: Date = new Date()): string {
  if (iso === undefined) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === now.toDateString()) return time;
  const monthDay = d.toLocaleDateString(locale, { month: "2-digit", day: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return `${monthDay} ${time}`;
  return `${d.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" })} ${time}`;
}

function ResultDot({ label }: { label: string | undefined }) {
  const cls = label === "win" ? "v3-dv-dot v3-dv-dot--acc" : label === "loss" ? "v3-dv-dot v3-dv-dot--err" : "v3-dv-dot";
  return <span className={cls} />;
}

function ResultChip({ label, t }: { label: string; t: (k: string) => string }) {
  const key = label === "win" ? "cockpit.outcomeWin" : label === "loss" ? "cockpit.outcomeLoss" : label === "draw" ? "cockpit.outcomeDraw" : "";
  const tone = label === "win" ? "accent" : label === "loss" ? "err" : "neutral";
  return (
    <span className="v3-dv-chip" data-tone={tone}>
      {key !== "" ? t(key) : label}
    </span>
  );
}

/** Small SVG progress ring for the daily auto-match budget. */
function ProgressRing({ value, idle, children }: { value: number; idle: boolean; children: ReactNode }) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const filled = Math.max(0, Math.min(1, value));
  return (
    <div className="relative h-[76px] w-[76px] shrink-0">
      <svg viewBox="0 0 76 76" className="h-full w-full -rotate-90">
        <circle cx="38" cy="38" r={R} fill="none" stroke="var(--color-deep)" strokeWidth="6" />
        {!idle && (
          <circle
            cx="38"
            cy="38"
            r={R}
            fill="none"
            stroke={filled >= 1 ? "var(--accent-2)" : "var(--accent)"}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${C * filled} ${C}`}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

function UsageMini({
  label,
  tokens,
  calls,
  t,
}: {
  label: string;
  tokens: number;
  calls: number;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  return (
    <div className="v3-dv-inset px-3 py-2.5">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-muted)]">{label}</div>
      <div className="mt-0.5 font-mono text-[16px] font-semibold tabular-nums text-[var(--text)]">{formatTokens(tokens)}</div>
      <div className="text-[10px] text-[var(--text-faint)]">{t("home.usage.calls", { n: calls })}</div>
    </div>
  );
}

function ActivityPill({ activity, connecting }: { activity: Activity; connecting: boolean }) {
  const { t } = useTranslation();
  if (connecting) {
    return (
      <span className="v3-dv-pill" data-tone="warn">
        <Loader2 size={12} className="animate-spin" />
        {t("play.activity.connecting")}
      </span>
    );
  }
  const pulse = activity === "in_match" || activity === "matching";
  return (
    <span className="v3-dv-pill" data-tone={ACTIVITY_TONE[activity]}>
      <i className={"dot" + (pulse ? " pulse" : "")} />
      {t(`play.activity.${activity}`)}
    </span>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  accent = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={"v3-dv-kpi" + (accent ? " v3-dv-kpi--acc" : "")}>
      <Icon size={13} className="k-ic" />
      <div className="k-val">{value}</div>
      <div className="k-lab">{label}</div>
      {sub !== undefined && <div className="k-sub">{sub}</div>}
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon?: ComponentType<{ size?: number; className?: string }>;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="v3-dv-card px-5 py-4">
      <div className="mb-3 flex items-start gap-2.5">
        {Icon !== undefined && <Icon size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />}
        <div>
          <div className="text-[14px] font-medium text-[var(--text)]">{title}</div>
          <div className="text-[12px] text-[var(--text-muted)]">{hint}</div>
        </div>
      </div>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function Btn({
  children,
  onClick,
  busy,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={busy || disabled} className="v3-dv-btn v3-dv-btn--primary shrink-0">
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

function QuickLink({
  href,
  icon: Icon,
  children,
  onClick,
}: {
  href?: string;
  icon: ComponentType<{ size?: number }>;
  children: ReactNode;
  onClick?: () => void;
}) {
  const cls = "v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm";
  // onClick variant (e.g. SSO "Open Dashboard") renders a button so we control the
  // navigation; otherwise a plain external anchor. The ExternalLink glyph stays in
  // both, since both ultimately open the system browser.
  if (onClick !== undefined) {
    return (
      <button onClick={onClick} className={cls}>
        <Icon size={13} />
        {children}
        <ExternalLink size={11} className="opacity-50" />
      </button>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      <Icon size={13} />
      {children}
      <ExternalLink size={11} className="opacity-50" />
    </a>
  );
}

function GamePicker({ value, onChange }: { value: string; onChange: (g: string) => void }) {
  const games = useLiveGames();
  return (
    <div className="v3-dv-seg">
      {games.map((g) => (
        <button key={g} onClick={() => onChange(g)} className={"v3-dv-seg-btn" + (value === g ? " on" : "")}>
          {gameLabel(g)}
        </button>
      ))}
    </div>
  );
}

function CopyRow({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
  };
  return (
    <div className="v3-dv-inset flex items-center gap-2 px-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text)]">{text}</span>
      <button
        onClick={copy}
        className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        {copied ? <Check size={13} className="v3-dv-ok" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function ActionLog({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <pre
      className={
        "max-h-56 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11.5px] leading-relaxed " +
        (error ? "v3-dv-card v3-dv-card--err v3-dv-err" : "v3-dv-inset")
      }
    >
      {text}
    </pre>
  );
}
