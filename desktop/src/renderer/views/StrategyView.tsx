// D8.5 — visual editor for the agent's own strategy prompts. These Markdown
// files (global + per-game) are injected into the LLM prompt during REAL matches
// by the runtime, so editing here changes how your agent plays. Reads/writes the
// SAME files the CLI/runtime use, via the strategy:read / strategy:write IPC
// (which resolve paths through the runtime's helper — never hardcoded).
//
// Fully bilingual (zh/en) like every other view. Empty docs are skipped during
// matches (stated in the UI).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Save, Check, Globe } from "lucide-react";

import { readStrategy, writeStrategy, useBridgeStatus } from "../useBridge";
import { webOrigin } from "../webOrigin";
import { PageHeader } from "../components/ui";
import { gameLabel } from "../../shared/games";
import type { StrategyScope } from "../../shared/ipc";

interface Doc {
  content: string;
  saved: string;
}
type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  // Tabs follow what main returned: "global" + the platform's live games
  // (strategy-host scopesFor) — no hardcoded scope list in the renderer.
  | { kind: "ready"; maxBytes: number; scopes: readonly StrategyScope[]; docs: Record<StrategyScope, Doc> };

const byteLen = (s: string) => new TextEncoder().encode(s).length;

export function StrategyView() {
  const { t } = useTranslation();
  const status = useBridgeStatus();
  // Deep-link to the public strategy guide (templates + how it works). Derived
  // from the configured bridge base URL like every other web link; the main
  // process' window-open handler sends http(s) to the user's browser.
  const howToUrl = `${webOrigin(status?.config?.baseUrl)}/how-to-win#strategy`;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [active, setActive] = useState<StrategyScope>("global");
  const [saving, setSaving] = useState<StrategyScope | null>(null);
  const [flash, setFlash] = useState<StrategyScope | null>(null);

  const load = () => {
    setState({ kind: "loading" });
    void readStrategy().then((r) => {
      if (r.error !== undefined) {
        setState({ kind: "error", message: r.error });
        return;
      }
      const docs = {} as Record<StrategyScope, Doc>;
      for (const d of r.docs) {
        docs[d.scope] = { content: d.content, saved: d.content };
      }
      setState({ kind: "ready", maxBytes: r.maxBytes, scopes: r.docs.map((d) => d.scope), docs });
    });
  };
  useEffect(load, []);

  // Warn before a window reload/close drops unsaved edits in any scope.
  const anyDirty = state.kind === "ready" && Object.values(state.docs).some((d) => d.content !== d.saved);
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyDirty]);

  const labelFor = (scope: StrategyScope) => (scope === "global" ? t("strategy.global") : gameLabel(scope));

  if (state.kind === "loading") return <Centered>{t("strategy.loading")}</Centered>;
  if (state.kind === "error") {
    return (
      <Centered>
        <div className="text-[var(--text-muted)]">{t("strategy.unavailable")}</div>
        <div className="mt-2 max-w-md font-mono text-[11px] text-[var(--text-faint)]">{state.message}</div>
      </Centered>
    );
  }

  // "global" is always present; guard anyway in case `active` outlives a reload.
  const doc = state.docs[active] ?? { content: "", saved: "" };
  const dirty = doc.content !== doc.saved;
  const bytes = byteLen(doc.content);
  const over = bytes > state.maxBytes;

  const setContent = (val: string) => {
    setState((prev) =>
      prev.kind === "ready" ? { ...prev, docs: { ...prev.docs, [active]: { ...prev.docs[active], content: val } } } : prev,
    );
  };

  const save = () => {
    if (!dirty || over) return;
    setSaving(active);
    const scope = active;
    const content = doc.content;
    void writeStrategy(scope, content).then((r) => {
      setSaving(null);
      if (r.ok) {
        setState((prev) =>
          prev.kind === "ready"
            ? { ...prev, docs: { ...prev.docs, [scope]: { content, saved: content } } }
            : prev,
        );
        setFlash(scope);
        window.setTimeout(() => setFlash((f) => (f === scope ? null : f)), 1800);
      }
    });
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <PageHeader
        eyebrow={t("eyebrow.strategy")}
        title={t("nav.strategy")}
        subtitle={
          <>
            {t("strategy.intro")}
            <a
              href={howToUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block w-fit text-[var(--accent-text)] hover:underline"
            >
              {t("strategy.howToLink")}
            </a>
          </>
        }
      />

      {/* Scope tabs */}
      <div className="mb-3 inline-flex gap-0.5 self-start rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
        {state.scopes.map((scope) => {
          const isDirty = state.docs[scope].content !== state.docs[scope].saved;
          return (
            <button
              key={scope}
              onClick={() => setActive(scope)}
              className={
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors " +
                (active === scope
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]")
              }
            >
              {scope === "global" && <Globe size={13} />}
              {labelFor(scope)}
              {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
            </button>
          );
        })}
      </div>

      {/* Editor */}
      <textarea
        value={doc.content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        placeholder={t("strategy.placeholder")}
        className="min-h-[320px] flex-1 resize-none rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 font-mono text-[13px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]/50"
      />

      {/* Footer: byte count + empty hint + save */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11px] text-[var(--text-faint)]">
          <span className={over ? "text-red-400" : ""}>
            {bytes} / {state.maxBytes} {t("strategy.bytes")}
          </span>
          <span className="mx-1.5">·</span>
          {over ? (
            <span className="text-red-400">{t("strategy.overBy", { n: bytes - state.maxBytes })}</span>
          ) : doc.content.trim() === "" ? (
            t("strategy.emptySkipped")
          ) : (
            t("strategy.injected")
          )}
        </div>
        <div className="flex items-center gap-2">
          {flash === active && (
            <span className="flex items-center gap-1 text-[12px] text-emerald-400">
              <Check size={13} /> {t("strategy.saved")}
            </span>
          )}
          <button
            onClick={save}
            disabled={!dirty || over || saving === active}
            className={
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors " +
              (dirty && !over
                ? "bg-[var(--accent)] text-white hover:opacity-90"
                : "cursor-default border border-[var(--border)] bg-[var(--surface)] text-[var(--text-faint)]")
            }
          >
            <Save size={14} />
            {saving === active ? t("strategy.saving") : t("strategy.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center text-[13px] text-[var(--text-muted)]">{children}</div>
    </div>
  );
}
