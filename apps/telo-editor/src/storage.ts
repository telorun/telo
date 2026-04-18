import type { AppSettings, EditorState, ViewId } from "./model";

const KEY = "telo-editor-v2";
const SETTINGS_KEY = "telo-editor-settings-v1";
const LEGACY_KEYS = ["telo-editor-v1"];

const VALID_VIEWS: Set<string> = new Set<ViewId>([
  "topology",
  "inventory",
  "source",
  "deployment",
]);

// Only lightweight cross-session state is persisted. The workspace itself
// is rebuilt by `loadWorkspace` on launch, not serialized.
interface PersistedState {
  rootDir: string | null;
  activeModulePath: string | null;
  activeView?: string;
}

export function saveState(state: EditorState): void {
  if (typeof window === "undefined") return;
  try {
    const persisted: PersistedState = {
      rootDir: state.workspace?.rootDir ?? null,
      activeModulePath: state.activeModulePath,
      activeView: state.activeView,
    };
    localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch {
    // localStorage may be full or unavailable — fail silently
  }
}

export function loadPersistedState(): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    for (const legacy of LEGACY_KEYS) localStorage.removeItem(legacy);
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedState;
    return {
      rootDir: data.rootDir ?? null,
      activeModulePath: data.activeModulePath ?? null,
      activeView: data.activeView && VALID_VIEWS.has(data.activeView) ? data.activeView : "topology",
    };
  } catch {
    return null;
  }
}

export function clearState(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function saveSettings(settings: AppSettings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export function loadSettings(): AppSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AppSettings;
  } catch {
    return null;
  }
}
