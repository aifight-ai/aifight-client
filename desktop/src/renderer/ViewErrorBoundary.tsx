// The view-level error boundary — the app's ONLY one.
//
// Why it exists: a render-time throw anywhere below the root used to unmount
// the ENTIRE window into a blank page (owner report 2026-08-02: the dashboard
// recent-match click hit WatchView's hook-order bug and the whole app went
// white — sidebar included, nothing clickable, no message). React's own
// console warning literally says "consider adding an error boundary".
//
// Placement: App.tsx wraps the VIEW AREA only (keyed by the active view id),
// so the sidebar and header always survive — the user can switch tabs, and
// switching remounts the boundary (the key) which clears the error state.
// The fallback shows the error text so a report is one copy-paste.

import { Component, type ReactNode } from "react";
import { withTranslation, type WithTranslation } from "react-i18next";

interface Props extends WithTranslation {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

class Boundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // The renderer has no persistent log sink; the console line at least
    // surfaces the stack in devtools for a dev build.
    console.error("[view-error-boundary]", error);
  }

  override render(): ReactNode {
    const { t } = this.props;
    if (this.state.error === null) return this.props.children;
    return (
      <div className="flex h-full items-start justify-center p-6">
        <div className="v3-dv-card w-full max-w-xl space-y-3 px-5 py-4">
          <div className="text-[14px] font-semibold text-[var(--text)]">{t("app.crash.title")}</div>
          <div className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t("app.crash.body")}</div>
          <pre className="max-h-48 overflow-auto rounded-md bg-[var(--hover)] p-3 font-mono text-[11px] leading-snug text-[var(--text-muted)]">
            {String(this.state.error.stack ?? this.state.error.message ?? this.state.error)}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="v3-dv-btn v3-dv-btn--sm"
          >
            {t("app.crash.retry")}
          </button>
        </div>
      </div>
    );
  }
}

export const ViewErrorBoundary = withTranslation()(Boundary);
