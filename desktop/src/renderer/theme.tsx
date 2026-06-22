// Theme: system / light / dark. "system" follows the OS appearance and
// updates live. The choice is persisted. applyInitialTheme() runs before
// React mounts (from main.tsx) to avoid a flash of the wrong theme.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeMode = "system" | "light" | "dark";
const THEME_KEY = "aifight.theme";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function effectiveDark(mode: ThemeMode): boolean {
  return mode === "dark" || (mode === "system" && systemPrefersDark());
}

function applyClass(dark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
  // The vendored game-visual CSS (game-visuals.css) themes via [data-theme],
  // mirroring the website. Keep it in sync with the class so matches follow the
  // desktop theme.
  root.setAttribute("data-theme", dark ? "dark" : "light");
}

function readMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

/** Called once at startup (before render) to set the initial theme class. */
export function applyInitialTheme(): void {
  applyClass(effectiveDark(readMode()));
}

interface ThemeContextValue {
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readMode());
  const [isDark, setIsDark] = useState<boolean>(() => effectiveDark(readMode()));

  useEffect(() => {
    applyClass(effectiveDark(mode));
    setIsDark(effectiveDark(mode));
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyClass(systemPrefersDark());
      setIsDark(systemPrefersDark());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = (next: ThemeMode) => {
    localStorage.setItem(THEME_KEY, next);
    setModeState(next);
  };

  return <ThemeContext.Provider value={{ mode, isDark, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
