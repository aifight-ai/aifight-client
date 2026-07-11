// Post-match self-review (SELF_REVIEW_DESIGN.md). Shown below the cockpit in the
// past-match (history) view. It is pure-local + at most one LLM call on the
// user's own key, so the panel NEVER generates on its own:
//   - on open it calls `review <id> --no-generate` (a read-only check that never
//     spends tokens),
//   - the user explicitly taps "Generate" / "Regenerate" to spend a call.
// Same data the CLI's `aifight review` reads/writes — no new IPC surface.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Lightbulb } from "lucide-react";

import { runCli } from "../useBridge";

/** Shape of a stored self-review (mirrors runtime's review/self-review.ts SelfReview). */
interface SelfReview {
  schema: 1;
  generated_at: string;
  trigger: "auto" | "manual";
  model: string;
  locale: string;
  prompt_version: string;
  report_text: string;
  suggestion: { scope: string; text: string } | null;
  token_usage: { input: number; output: number };
  source_strategy_hashes: string[];
}

export function ReviewSection({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  // Starts false so the static/SSR render (no effects) degrades to the generate
  // state instead of a stuck spinner; the mount effect flips it true immediately
  // in a live render, so there is no premature "Generate" flash in the app.
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<SelfReview | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On open: read-only check (never spends tokens). Guard against setState after
  // unmount — the user may leave the detail view before the call resolves.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void runCli({ kind: "review", sessionId, mode: "no-generate" }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.exitCode !== 0) {
        setError(r.error ?? r.stderr);
        return;
      }
      const got = (r.json as { review?: SelfReview | null } | undefined)?.review ?? null;
      setReview(got);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Generate — costs one LLM call on the user's key. `regen` forces a fresh
  // review (overwrites the stored one); without it the CLI returns the cached
  // review, so the first "Generate" omits it and "Regenerate" passes it.
  const generate = (regen: boolean) => {
    setGenerating(true);
    setError(null);
    void runCli({ kind: "review", sessionId, mode: regen ? "regen" : "default" }).then((r) => {
      setGenerating(false);
      if (r.exitCode !== 0) {
        setError(r.error ?? r.stderr);
        return;
      }
      const got = (r.json as { review?: SelfReview | null } | undefined)?.review ?? null;
      if (got === null) {
        setError(t("review.failed"));
        return;
      }
      setReview(got);
    });
  };

  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text)]">
            <Sparkles size={14} className="text-[var(--accent)]" />
            {t("review.panel")}
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">{t("review.hint")}</div>
        </div>
        {review !== null && (
          <button
            onClick={() => generate(true)}
            disabled={generating}
            className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)] disabled:opacity-60"
          >
            {generating ? t("review.generating") : t("review.regenerate")}
          </button>
        )}
      </div>

      <div className="p-4">
        {loading ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-faint)]">{t("review.none")}</div>
        ) : review !== null ? (
          <div className="space-y-3">
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">
              {review.report_text}
            </div>
            {review.suggestion !== null && (
              <div className="rounded-lg border border-[var(--accent-soft)] bg-[var(--accent-soft)] p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--accent-text)]">
                  <Lightbulb size={13} />
                  {t("review.suggestion")}
                  <span className="font-mono lowercase text-[var(--text-muted)]">[{review.suggestion.scope}]</span>
                </div>
                <div className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text)]">{review.suggestion.text}</div>
              </div>
            )}
            <div className="text-[10.5px] text-[var(--text-faint)]">
              {review.model} · tokens in {review.token_usage.input} / out {review.token_usage.output} · {review.trigger}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              onClick={() => generate(false)}
              disabled={generating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              <Sparkles size={14} />
              {generating ? t("review.generating") : t("review.generate")}
            </button>
            <div className="text-[11px] text-[var(--text-muted)]">{t("review.costHint")}</div>
          </div>
        )}
        {error !== null && error !== "" && (
          <div className="mt-2 text-[11px] text-[var(--text-muted)]">{error}</div>
        )}
      </div>
    </div>
  );
}
