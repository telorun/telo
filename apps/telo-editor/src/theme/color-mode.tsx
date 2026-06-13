import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ColorMode = "light" | "dark";
/** User preference; `"system"` follows the OS, the other two pin a mode. */
export type ThemePreference = "light" | "dark" | "system";

interface ColorModeValue {
  /** Resolved mode after applying the preference. */
  mode: ColorMode;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ColorModeContext = createContext<ColorModeValue>({
  mode: "light",
  preference: "system",
  setPreference: () => {},
});

/** The editor's resolved color mode — read it to mirror the editor's appearance
 *  into embedded surfaces (e.g. the debug-ui panel). */
export function useColorMode(): ColorMode {
  return useContext(ColorModeContext).mode;
}

/** Preference + setter, for a theme switch control. */
export function useColorModeControls(): ColorModeValue {
  return useContext(ColorModeContext);
}

/** The Monaco built-in theme matching the editor's mode. Monaco paints its own
 *  surface (it doesn't read the `.dark` class), so its `<Editor theme>` must be
 *  set explicitly. */
export function useMonacoTheme(): "vs-dark" | "light" {
  return useColorMode() === "dark" ? "vs-dark" : "light";
}

const MEDIA = "(prefers-color-scheme: dark)";
const STORAGE_KEY = "telo-editor:color-mode";

function systemMode(): ColorMode {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MEDIA).matches
      ? "dark"
      : "light"
    : "light";
}

function loadPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // localStorage may be unavailable — fall back to system.
  }
  return "system";
}

/**
 * Owns the editor's color mode: a `"light" | "dark" | "system"` preference
 * (persisted to localStorage), resolved against the OS preference when
 * `"system"`. Applies the `.dark` class the Tailwind config keys off
 * (`@custom-variant dark`) so the whole editor switches, and exposes the
 * resolved mode + controls — the editor is the source of truth, including for
 * the debug-ui it embeds.
 */
export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(loadPreference);
  const [system, setSystem] = useState<ColorMode>(systemMode);

  useEffect(() => {
    const mq = window.matchMedia(MEDIA);
    const onChange = (): void => setSystem(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const mode: ColorMode = preference === "system" ? system : preference;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", mode === "dark");
  }, [mode]);

  const setPreference = (next: ThemePreference): void => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-fatal — the preference just won't persist across reloads.
    }
  };

  return (
    <ColorModeContext.Provider value={{ mode, preference, setPreference }}>
      {children}
    </ColorModeContext.Provider>
  );
}
