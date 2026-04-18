import { useEffect, useRef, useState } from "react";
import type { AppSettings, EditorState, ViewId } from "../model";
import { loadPersistedState, loadSettings, saveSettings, saveState } from "../storage";

export interface PersistedEditorState {
  rootDir: string | null;
  activeModulePath: string | null;
  activeView: ViewId;
}

interface UseEditorPersistenceResult {
  state: EditorState;
  setState: React.Dispatch<React.SetStateAction<EditorState>>;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  /** Hint values loaded from localStorage at hydration — the Editor uses these
   *  to decide whether to reopen the last workspace on launch. Null before
   *  hydration runs. */
  persistedHint: PersistedEditorState | null;
}

export function useEditorPersistence(
  initialState: EditorState,
  defaultSettings: AppSettings,
): UseEditorPersistenceResult {
  const [state, setState] = useState<EditorState>(initialState);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [persistedHint, setPersistedHint] = useState<PersistedEditorState | null>(null);

  const isHydrated = useRef(false);

  useEffect(() => {
    if (isHydrated.current) saveState(state);
  }, [state]);

  useEffect(() => {
    if (isHydrated.current) saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const saved = loadPersistedState();
    if (saved) {
      setPersistedHint({
        rootDir: saved.rootDir,
        activeModulePath: saved.activeModulePath,
        activeView: (saved.activeView ?? "topology") as ViewId,
      });
    }

    const savedSettings = loadSettings();
    // Merge with defaults so older persisted shapes inherit fields added in
    // later editor versions (e.g. activeRunAdapterId was introduced after
    // registryServers — pre-existing installs must not land with it missing).
    if (savedSettings) setSettings({ ...defaultSettings, ...savedSettings });

    isHydrated.current = true;
  }, []);

  return { state, setState, settings, setSettings, persistedHint };
}
