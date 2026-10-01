import type { WorkspaceBridge } from "../agent";
import { sha256Hex } from "../agent/hash";
import { SYNC_EXCLUDED_DIRS } from "../agent/sync";
import { pathJoin } from "../loader/paths";
import type { WorkspaceAdapter } from "../model";

/**
 * The editor's side of the workspace it shares with the authoring agent: its
 * tree content-hashed for the two-way sync, the agent's writes reflected
 * through the same adapter and `afterFileMutation` the manual editors use, and
 * the editor's own path for a file the agent names. The agent's paths are
 * relative to the workspace; `rootDir` is where the editor keeps it, and this
 * is the only place the two are joined.
 */
export function editorWorkspaceBridge({
  rootDir,
  adapter,
  afterFileMutation,
}: {
  rootDir: string;
  /** The workspace's adapter as it is now; null with none open. */
  adapter: () => WorkspaceAdapter | null;
  afterFileMutation: (affected: string[]) => Promise<void>;
}): WorkspaceBridge {
  const abs = (rel: string) => (rel ? pathJoin(rootDir, rel) : rootDir);
  return {
    async snapshot() {
      const workspace = adapter();
      const out = new Map<string, string>();
      if (!workspace) return out;
      const walk = async (rel: string) => {
        for (const entry of await workspace.listDir(abs(rel))) {
          if (SYNC_EXCLUDED_DIRS.has(entry.name)) continue;
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory) await walk(childRel);
          else out.set(childRel, await sha256Hex(await workspace.readFile(abs(childRel))));
        }
      };
      await walk("");
      return out;
    },
    async readFile(rel) {
      const workspace = adapter();
      if (!workspace) throw new Error("no workspace open");
      return workspace.readFile(abs(rel));
    },
    async applyChanges(writes, deletes) {
      const workspace = adapter();
      if (!workspace) return;
      const affected: string[] = [];
      for (const w of writes) {
        await workspace.writeFile(abs(w.path), w.content);
        affected.push(abs(w.path));
      }
      for (const d of deletes) {
        try {
          await workspace.delete(abs(d));
          affected.push(abs(d));
        } catch {
          /* already gone */
        }
      }
      if (affected.length) await afterFileMutation(affected);
    },
    editorFile(path) {
      // Absolute, a drive letter or a URL: not a path inside the workspace.
      if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return null;
      const inside: string[] = [];
      for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment !== "..") inside.push(segment);
        else if (inside.pop() === undefined) return null;
      }
      return inside.length === 0 ? null : abs(inside.join("/"));
    },
  };
}
