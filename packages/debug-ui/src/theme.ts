import { useEffect, useState } from "react";

/** Requested color theme. `"system"` (the default) follows the OS preference. */
export type DebugTheme = "light" | "dark" | "system";

const MEDIA = "(prefers-color-scheme: dark)";
const STORAGE_KEY = "telo-debug-ui:theme";

/** The persisted standalone theme choice, or `"system"`. Used when the panel
 *  owns its mode (no host-supplied `theme`) so the toggle survives a reload. */
export function loadStoredTheme(): DebugTheme {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // localStorage may be unavailable — fall back to system.
  }
  return "system";
}

export function storeTheme(theme: DebugTheme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Non-fatal — the choice just won't persist across reloads.
  }
}

function systemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia(MEDIA).matches ? "dark" : "light";
  }
  return "dark";
}

/** Resolve a {@link DebugTheme} to a concrete `"light"` / `"dark"`. When `theme`
 *  is `"system"` (or omitted) it tracks the OS preference and updates live; an
 *  explicit `"light"` / `"dark"` (e.g. passed by an embedding host) wins. */
export function useResolvedTheme(theme: DebugTheme = "system"): "light" | "dark" {
  const [system, setSystem] = useState<"light" | "dark">(systemTheme);
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia(MEDIA);
    const onChange = (): void => setSystem(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
  return theme === "system" ? system : theme;
}
