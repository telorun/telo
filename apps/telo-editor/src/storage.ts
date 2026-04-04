import type { Application, AppSettings, EditorState, NavigationEntry, PanelEntry, ParsedManifest } from './model'

const KEY = 'telo-editor-v1'
const SETTINGS_KEY = 'telo-editor-settings-v1'

// ---------------------------------------------------------------------------
// Serialization helpers — Map/Set don't JSON-round-trip natively
// ---------------------------------------------------------------------------

interface SerializedApplication {
  rootPath: string
  modules: Record<string, ParsedManifest>
  importGraph: Record<string, string[]>
  importedBy: Record<string, string[]>
}

interface PersistedState {
  application: SerializedApplication | null
  activeModulePath: string | null
  navigationStack: NavigationEntry[]
  selectedResource: { kind: string; name: string } | null
  panelStack: PanelEntry[]
}

function serializeApplication(app: Application): SerializedApplication {
  return {
    rootPath: app.rootPath,
    modules: Object.fromEntries(app.modules),
    importGraph: Object.fromEntries(
      Array.from(app.importGraph.entries()).map(([k, v]) => [k, Array.from(v)])
    ),
    importedBy: Object.fromEntries(
      Array.from(app.importedBy.entries()).map(([k, v]) => [k, Array.from(v)])
    ),
  }
}

function deserializeApplication(data: SerializedApplication): Application {
  return {
    rootPath: data.rootPath,
    modules: new Map(Object.entries(data.modules)),
    importGraph: new Map(
      Object.entries(data.importGraph).map(([k, v]) => [k, new Set(v)])
    ),
    importedBy: new Map(
      Object.entries(data.importedBy).map(([k, v]) => [k, new Set(v)])
    ),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function saveState(state: EditorState): void {
  if (typeof window === 'undefined') return
  try {
    const persisted: PersistedState = {
      application: state.application ? serializeApplication(state.application) : null,
      activeModulePath: state.activeModulePath,
      navigationStack: state.navigationStack,
      selectedResource: state.selectedResource,
      panelStack: state.panelStack,
    }
    localStorage.setItem(KEY, JSON.stringify(persisted))
  } catch {
    // localStorage may be full or unavailable — fail silently
  }
}

export function loadState(): Partial<EditorState> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as PersistedState
    return {
      application: data.application ? deserializeApplication(data.application) : null,
      activeModulePath: data.activeModulePath ?? null,
      navigationStack: data.navigationStack ?? [],
      selectedResource: data.selectedResource ?? null,
      panelStack: data.panelStack ?? [],
      diagnosticsByResource: new Map(),
    }
  } catch {
    return null
  }
}

export function clearState(): void {
  if (typeof window === 'undefined') return
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

export function saveSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch { /* ignore */ }
}

export function loadSettings(): AppSettings | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    return JSON.parse(raw) as AppSettings
  } catch {
    return null
  }
}
