import React from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import "./i18n";
import { App } from "./App";
import { applyInitialTheme, ThemeProvider } from "./theme";
import { installDemoBridge } from "./demoBridge";

// Browser demo mode (?demo): mock the bridge API so the configured dashboard
// renders in plain `vite dev`. Never active in the packaged app — there the
// preload has already defined window.aifight.
if (window.aifight === undefined && new URLSearchParams(location.search).has("demo")) {
  installDemoBridge();
}

// Set the theme class before first paint (no flash of wrong theme).
applyInitialTheme();

const container = document.getElementById("root");
if (!container) throw new Error("root element missing");

createRoot(container).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
