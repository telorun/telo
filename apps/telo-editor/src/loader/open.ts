import type { ManifestAdapter } from "@telorun/analyzer";
import type { WorkspaceAdapter } from "../model";
import { TauriFsAdapter } from "./adapters/tauri-fs";
import { FsaAdapter } from "./adapters/fsa";
import { LocalStorageAdapter } from "./adapters/local-storage";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

export function isInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

// A no-op local adapter — supports nothing, used when only registry adapters are needed.
export const noopAdapter: ManifestAdapter = {
  supports: () => false,
  read: (url) => Promise.reject(new Error(`No adapter for: ${url}`)),
  resolveRelative: (_base, relative) => relative,
};

// ---------------------------------------------------------------------------
// Workspace open
// ---------------------------------------------------------------------------

export interface OpenedWorkspace {
  manifestAdapter: ManifestAdapter;
  workspaceAdapter: WorkspaceAdapter;
  rootDir: string;
}

/** Constructs adapters for a known rootDir without showing a picker. Used to
 *  auto-restore a workspace on mount. Returns null when the current environment
 *  cannot re-attach to the path silently (e.g. FSA, where the directory handle
 *  isn't persisted across reloads). */
export function reopenWorkspaceAt(rootDir: string): OpenedWorkspace | null {
  if (isInTauri()) {
    const adapter = new TauriFsAdapter();
    return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir };
  }
  if (!supportsDirectoryPicker()) {
    // Firefox/Safari — data lives in localStorage, always available.
    const adapter = new LocalStorageAdapter(rootDir);
    return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir };
  }
  // FSA: can't re-attach silently; caller should show a re-open affordance.
  return null;
}

export async function openWorkspaceDirectory(): Promise<OpenedWorkspace | null> {
  if (isInTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true });
    if (!result || typeof result !== "string") return null;
    const adapter = new TauriFsAdapter();
    return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir: result };
  }

  if (supportsDirectoryPicker()) {
    const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    // Request readwrite permission upfront so first save doesn't prompt mid-edit.
    const perm = await dirHandle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return null;
    const rootDir = "/" + dirHandle.name;
    const adapter = new FsaAdapter(dirHandle, rootDir);
    return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir };
  }

  // Firefox/Safari fallback — localStorage-backed virtual workspace.
  const rootDir = "/workspace";
  const adapter = new LocalStorageAdapter(rootDir);
  return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir };
}
