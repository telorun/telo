import { isTauri } from "@tauri-apps/api/core";
import type { ByteStore } from "./byte-store";
import { OpfsByteStore } from "./opfs-byte-store";
import { TauriByteStore } from "./tauri-byte-store";
import { WorkingCopy } from "./working-copy";
import { WorkingCopyAdapter } from "./working-copy-adapter";

/** Where a project's working copy lives on this device. */
export function workingCopyStore(projectId: string): ByteStore {
  return isTauri() ? new TauriByteStore(projectId) : new OpfsByteStore(projectId);
}

export function workingCopyOf(projectId: string): WorkingCopy {
  return new WorkingCopy(workingCopyStore(projectId));
}

const writeListeners = new Set<(projectId: string) => void>();

/** Notified after the editor writes into a working copy. */
export function onWorkingCopyWrite(listener: (projectId: string) => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

/** The working copy as the editor's workspace storage backend. */
export function workingCopyAdapter(projectId: string): WorkingCopyAdapter {
  return new WorkingCopyAdapter(projectId, workingCopyStore(projectId), () => {
    for (const listener of writeListeners) listener(projectId);
  });
}
