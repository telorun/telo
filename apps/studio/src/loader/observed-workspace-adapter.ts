import type { DirEntry, WorkspaceAdapter } from "../model";

/** What changed in the open workspace: the paths a write through the adapter
 *  touched, or the whole workspace when it was read again from its store. */
export type WorkspaceChange =
  | { readonly kind: "paths"; readonly paths: readonly string[] }
  | { readonly kind: "workspace" };

export interface WorkspaceChanges {
  /** Calls `listener` for every change until the returned function is called. */
  subscribe(listener: (change: WorkspaceChange) => void): () => void;
}

/** One feed for the editor's lifetime; `publish` is the workspace owner's. */
export function createWorkspaceChanges(): WorkspaceChanges & {
  publish(change: WorkspaceChange): void;
} {
  const listeners = new Set<(change: WorkspaceChange) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(change) {
      for (const listener of [...listeners]) listener(change);
    },
  };
}

/**
 * The open workspace's adapter, wrapped once when the workspace opens so every
 * write through it — a save, a form edit, a file operation, the agent's sync —
 * is published as the paths it wrote, deleted or renamed. A reader that depends
 * on file contents (the Variables view) listens here rather than at each writer.
 */
export class ObservedWorkspaceAdapter implements WorkspaceAdapter {
  constructor(
    /** The adapter the workspace was opened with. */
    readonly inner: WorkspaceAdapter,
    private readonly publish: (change: WorkspaceChange) => void,
  ) {}

  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }

  readBytes(path: string): Promise<Uint8Array> {
    return this.inner.readBytes(path);
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.inner.listDir(path);
  }

  createDir(path: string): Promise<void> {
    return this.inner.createDir(path);
  }

  async writeFile(path: string, text: string): Promise<void> {
    await this.inner.writeFile(path, text);
    this.publish({ kind: "paths", paths: [path] });
  }

  async delete(path: string): Promise<void> {
    await this.inner.delete(path);
    this.publish({ kind: "paths", paths: [path] });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.inner.rename(from, to);
    this.publish({ kind: "paths", paths: [from, to] });
  }
}
