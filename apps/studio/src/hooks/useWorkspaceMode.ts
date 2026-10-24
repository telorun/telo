import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { cloudProjectIdOf } from "../cloud/working-copy-adapter";
import {
  loadWorkspaceSessionEntry,
  newWorkspaceSessionEntry,
  saveWorkspaceSessionEntry,
  type WorkspaceMode,
} from "../run/workspace-session-entry";

export interface WorkspaceModeState {
  /** How the open workspace is used: null while the choice is still to be
   *  made, undefined until the open workspace's entry has been read — so a
   *  switch never shows the previous workspace's mode for the new one. */
  workspaceMode: WorkspaceMode | null | undefined;
  chooseWorkspaceMode(mode: WorkspaceMode): void;
  /** The mode the next workspace to open takes without asking. */
  openingModeRef: MutableRefObject<WorkspaceMode | null>;
}

/** The open workspace's mode, remembered per workspace root in its session
 *  entry and held keyed by that root. */
export function useWorkspaceMode(rootDir: string | null): WorkspaceModeState {
  const [held, setHeld] = useState<{ root: string; mode: WorkspaceMode | null } | null>(null);
  const openingModeRef = useRef<WorkspaceMode | null>(null);
  useEffect(() => {
    if (!rootDir) {
      setHeld(null);
      return;
    }
    const stored = loadWorkspaceSessionEntry(rootDir);
    const opening = openingModeRef.current;
    openingModeRef.current = null;
    if (opening) {
      saveWorkspaceSessionEntry(
        rootDir,
        stored ? { ...stored, mode: opening } : newWorkspaceSessionEntry(opening, cloudProjectIdOf(rootDir)),
      );
      setHeld({ root: rootDir, mode: opening });
      return;
    }
    setHeld({ root: rootDir, mode: stored?.mode ?? null });
  }, [rootDir]);

  const chooseWorkspaceMode = useCallback(
    (mode: WorkspaceMode) => {
      if (!rootDir) return;
      const stored = loadWorkspaceSessionEntry(rootDir);
      saveWorkspaceSessionEntry(
        rootDir,
        stored ? { ...stored, mode } : newWorkspaceSessionEntry(mode, cloudProjectIdOf(rootDir)),
      );
      setHeld({ root: rootDir, mode });
    },
    [rootDir],
  );

  const workspaceMode = rootDir === null ? null : held?.root === rootDir ? held.mode : undefined;
  return { workspaceMode, chooseWorkspaceMode, openingModeRef };
}
