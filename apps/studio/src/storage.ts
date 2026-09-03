import type { AppSettings, EditorState, EditorTab, ViewId } from "./model";
import { LOCAL_KEYS, LOCAL_PREFIXES } from "./storage-keys";

const KEY = LOCAL_KEYS.uiState;
const SETTINGS_KEY = LOCAL_KEYS.settings;

const TERMS_KEY = LOCAL_KEYS.acceptedTerms;

/** Accepted terms versions, keyed by runner id. Each runner advertises its own
 *  terms + version; acceptance is recorded per runner so switching runners (or
 *  the operator bumping the version) re-prompts. */
type AcceptedTermsMap = Record<string, string>;

function loadAcceptedTerms(): AcceptedTermsMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TERMS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as AcceptedTermsMap;
  } catch {
    return {};
  }
}

/** Whether `version` of `runnerId`'s terms has been accepted. Read synchronously
 *  so the run flow can gate without a flash. */
export function isTermsAcceptedFor(runnerId: string, version: string): boolean {
  return loadAcceptedTerms()[runnerId] === version;
}

export function acceptTermsFor(runnerId: string, version: string): void {
  if (typeof window === "undefined") return;
  try {
    const map = loadAcceptedTerms();
    map[runnerId] = version;
    window.localStorage.setItem(TERMS_KEY, JSON.stringify(map));
  } catch {
    /* localStorage unavailable — the gate will simply show again next time */
  }
}

const VALID_VIEWS: Set<string> = new Set<ViewId>(["topology", "outline", "source", "run"]);

/** Views a persisted hint may still name: "deployment" preceded the Variables tab,
 *  and four separate lists preceded the Outline tab. A hint from before either
 *  change still says where the user was, so it is mapped rather than dropped. */
const RENAMED_VIEWS: Record<string, ViewId> = {
  deployment: "run",
  imports: "outline",
  definitions: "outline",
  resources: "outline",
  kinds: "outline",
};

function normalizeView(view: string | undefined): string {
  if (view && RENAMED_VIEWS[view]) return RENAMED_VIEWS[view];
  return view && VALID_VIEWS.has(view) ? view : "topology";
}

// Only lightweight cross-session state is persisted. The workspace itself
// is rebuilt by `loadWorkspace` on launch, not serialized.
interface PersistedState {
  rootDir: string | null;
  activeModulePath: string | null;
  activeView?: string;
  openTabs?: EditorTab[];
  activeTabId?: string | null;
  expandedDirs?: string[];
}

/** Runtime guard for a persisted tab — localStorage may hold corrupted or
 *  hand-edited data that violates the type, so validate element shape before
 *  trusting it. */
function isValidTab(t: unknown): t is EditorTab {
  if (typeof t !== "object" || t === null) return false;
  const tab = t as { type?: unknown; path?: unknown };
  return (tab.type === "module" || tab.type === "file") && typeof tab.path === "string";
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
      openTabs: state.openTabs,
      activeTabId: state.activeTabId,
      expandedDirs: state.expandedDirs,
    };
    localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch {
    // localStorage may be full or unavailable — fail silently
  }
}

export function loadPersistedState(): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    const data = raw ? (JSON.parse(raw) as PersistedState) : null;
    return {
      rootDir: data?.rootDir ?? detectStoredWorkspaceRoot(),
      activeModulePath: data?.activeModulePath ?? null,
      activeView: normalizeView(data?.activeView),
      openTabs: Array.isArray(data?.openTabs) ? data.openTabs.filter(isValidTab) : [],
      activeTabId: typeof data?.activeTabId === "string" ? data.activeTabId : null,
      expandedDirs: Array.isArray(data?.expandedDirs)
        ? data.expandedDirs.filter((d): d is string => typeof d === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** Best-effort recovery hint: if any `telo-studio:workspace:` keys exist
 *  under `/workspace` (the LocalStorageAdapter's default root in
 *  `openWorkspaceDirectory`), return `/workspace` so studio offers to
 *  reopen them. Covers the recovery case where the persisted `rootDir`
 *  hint was lost (init-time error, partial migration, etc.) but the user's
 *  workspace files are still stored in localStorage. */
function detectStoredWorkspaceRoot(): string | null {
  if (typeof window === "undefined") return null;
  const PREFIX = `${LOCAL_PREFIXES.workspace}/workspace/`;
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
