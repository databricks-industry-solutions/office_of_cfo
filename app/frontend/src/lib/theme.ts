import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const THEME_KEY = "cfo.theme";
const listeners = new Set<(t: Theme) => void>();

/** Read the persisted theme preference. Defaults to "light". */
export function getTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Apply a theme to the document (toggles `.dark` on <html>). */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Persist, apply, and broadcast a theme change to subscribers. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
  applyTheme(theme);
  listeners.forEach((l) => l(theme));
}

/** Subscribe to theme changes; returns an unsubscribe fn. */
export function subscribeTheme(cb: (t: Theme) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Apply the persisted theme on startup. */
export function initTheme(): void {
  applyTheme(getTheme());
}

/** React hook: current theme + a setter, kept in sync across all controls. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  useEffect(() => subscribeTheme(setThemeState), []);
  return [theme, setTheme];
}
