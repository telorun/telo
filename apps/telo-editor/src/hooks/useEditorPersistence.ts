import { useEffect, useRef, useState } from "react";
import type { AppSettings, EditorState } from "../model";
import { loadSettings, loadState, saveSettings, saveState } from "../storage";

interface UseEditorPersistenceResult {
  state: EditorState;
  setState: React.Dispatch<React.SetStateAction<EditorState>>;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
}

export function useEditorPersistence(
  initialState: EditorState,
  defaultSettings: AppSettings,
): UseEditorPersistenceResult {
  const [state, setState] = useState<EditorState>(initialState);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);

  // isHydrated tracks whether the post-mount restore has run.
  // Effects run in definition order, so save effects skip initial render.
  const isHydrated = useRef(false);

  useEffect(() => {
    if (isHydrated.current) saveState(state);
  }, [state]);

  useEffect(() => {
    if (isHydrated.current) saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const saved = loadState();
    if (saved) setState((s) => ({ ...s, ...saved }));

    const savedSettings = loadSettings();
    if (savedSettings) setSettings(savedSettings);

    isHydrated.current = true;
  }, []);

  return { state, setState, settings, setSettings };
}
