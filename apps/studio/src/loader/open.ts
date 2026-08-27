import type { ManifestSource } from "@telorun/analyzer";
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

// A framed document (VS Code's Simple Browser, any embedded preview) exposes
// `showDirectoryPicker` but cannot complete it: the folder dialog opens, and the
// write-permission prompt that follows the selection has nowhere to render, so
// the pick is auto-denied as an AbortError. Feature-detecting the method alone
// therefore offers a picker that can only ever fail — treat framed as
// unsupported and fall through to the localStorage workspace instead.
function supportsDirectoryPicker(): boolean {
  if (typeof window === "undefined" || !("showDirectoryPicker" in window)) return false;
  try {
    return window.self === window.top;
  } catch {
    return false; // Reading `top` across origins throws — framed by definition.
  }
}

/** Whether this environment can offer a CHOICE of workspace.
 *
 *  `"chooser"` — a directory picker exists (Tauri, or a top-level document with
 *  the File System Access API), so opening is a real operation and repeating it
 *  switches workspaces.
 *
 *  `"single"` — no picker: every open resolves to the one localStorage-backed
 *  workspace. Offering to "open" it a second time picks the same one, which is
 *  why the surfaces read this rather than each re-deriving the environment. */
export function workspaceOpenMode(): "chooser" | "single" {
  return isInTauri() || supportsDirectoryPicker() ? "chooser" : "single";
}

// A no-op local adapter — supports nothing, used when only registry adapters are needed.
export const noopAdapter: ManifestSource = {
  supports: () => false,
  read: (url) => Promise.reject(new Error(`No source for: ${url}`)),
  resolveRelative: (_base, relative) => relative,
};

// ---------------------------------------------------------------------------
// Workspace open
// ---------------------------------------------------------------------------

export interface OpenedWorkspace {
  manifestAdapter: ManifestSource;
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
    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (err) {
      // Dismissing the picker — or the write-permission prompt behind it — is a
      // cancel, not a failure: report it as "nothing opened", the way the Tauri
      // branch above does. Every other rejection still propagates.
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
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
