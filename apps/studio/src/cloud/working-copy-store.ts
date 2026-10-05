import { isTauri } from "@tauri-apps/api/core";
import type { ByteStore } from "./byte-store";
import { OpfsByteStore } from "./opfs-byte-store";
import { TauriByteStore } from "./tauri-byte-store";
import { WorkingCopy } from "./working-copy";
import { WorkingCopyAdapter } from "./working-copy-adapter";

/** Where a workspace's working copy lives on this device. */
export function workingCopyStore(workspaceId: string): ByteStore {
  return isTauri() ? new TauriByteStore(workspaceId) : new OpfsByteStore(workspaceId);
}

export function workingCopyOf(workspaceId: string): WorkingCopy {
  return new WorkingCopy(workingCopyStore(workspaceId));
}

const writeListeners = new Set<(workspaceId: string) => void>();

/** Notified after the editor writes into a working copy. */
export function onWorkingCopyWrite(listener: (workspaceId: string) => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

/** The working copy as the editor's workspace storage backend. */
export function workingCopyAdapter(workspaceId: string): WorkingCopyAdapter {
  return new WorkingCopyAdapter(workspaceId, workingCopyStore(workspaceId), () => {
    for (const listener of writeListeners) listener(workspaceId);
  });
}
