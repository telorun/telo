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
    // Only overwrite the persisted `rootDir` when state has a workspace.
    // A transient null (init failure, error state, async-load gap) must not
    // clobber the last-known rootDir — that would lose the auto-restore
    // hint and silently strand the user's localStorage workspace files.
    let prev: PersistedState | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) prev = JSON.parse(raw) as PersistedState;
    } catch {
      // ignore — treat as no prior state
    }
    const persisted: PersistedState = {
      rootDir: state.workspace?.rootDir ?? prev?.rootDir ?? null,
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
    const data = raw ? (JSON.parse(raw) as PersistedState) : null;
    return {
      rootDir: data?.rootDir ?? detectStoredWorkspaceRoot(),
      activeModulePath: data?.activeModulePath ?? null,
      activeView:
        data?.activeView && VALID_VIEWS.has(data.activeView) ? data.activeView : "topology",
    };
  } catch {
    return null;
  }
}

/** Best-effort recovery hint: if any `telo-editor-workspace:` keys exist
 *  under `/workspace` (the LocalStorageAdapter's default root in
 *  `openWorkspaceDirectory`), return `/workspace` so the editor offers to
 *  reopen them. Covers the recovery case where the persisted `rootDir`
 *  hint was lost (init-time error, partial migration, etc.) but the user's
 *  workspace files are still stored in localStorage. */
function detectStoredWorkspaceRoot(): string | null {
  if (typeof window === "undefined") return null;
  const PREFIX = "telo-editor-workspace:/workspace/";
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(PREFIX)) return "/workspace";
  }
  return null;
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
