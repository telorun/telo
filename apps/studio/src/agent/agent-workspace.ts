/**
 * The two surfaces a shared workspace can be reached through, behind one
 * interface so the convergence logic in `sync.ts` is written once.
 *
 * A STANDALONE agent owns a directory inside its own container and serves it on
 * its own `/workspace` routes. A CO-RESIDENT agent has no directory of its own:
 * it writes the watch session's shared volume with its filesystem tools, and
 * everything outside the pod — this editor included — reaches that volume
 * through the runner's `/v1/sessions/:id/workspace` surface. Same directory,
 * two ways in.
 */

import type { RunSession } from "../run/types";
import type { AgentClient } from "./client";
import type { AgentWorkspace, TreeFile } from "./types";

/** The kernel anchors its `.telo` cache at the directory holding this file, and
 *  a watch session's runner seeds one at the workspace root when the bundle
 *  brings none. It is infrastructure of the session rather than a file the user
 *  authored, so it is excluded from the agent sync in both directions —
 *  deleting it would scatter one shared module cache back into one per app.
 *  (Mirrors runner-core's `WORKSPACE_MARKER_FILENAME`; a local constant so
 *  editor code doesn't depend on the Node-only package.) */
const WORKSPACE_MARKER_FILENAME = "telo-workspace.yaml";

/** The agent's own container directory, over its `/workspace` routes. */
export function ownWorkspace(client: AgentClient): AgentWorkspace {
  return {
    tree: () => client.workspaceTree(),
    readFile: (path) => client.readWorkspaceFile(path),
    apply: (write, remove) => client.syncWorkspace(write, remove),
    // Nothing here is anyone's but the editor's: this directory starts empty
    // and holds exactly what the editor and the agent put in it.
    excludedPaths: new Set<string>(),
  };
}

/**
 * A watch session's shared volume, over the runner's session routes. The
 * session's `syncWorkspace` is the same write path the editor's save uses, so an
 * agent-driven write and a user-driven save reach the volume identically — and
 * both are rate-limited as reload causes, which is what they are.
 */
export function sessionWorkspace(session: RunSession): AgentWorkspace | null {
  const { workspaceTree, readWorkspaceFile, syncWorkspace } = session;
  // Null rather than a throw: the caller resolves this inside a render effect,
  // where the honest degradation is "this session offers no co-resident agent"
  // — which it already handles — and a throw would take the editor down over a
  // session that merely predates the workspace surface.
  if (!workspaceTree || !readWorkspaceFile || !syncWorkspace) return null;
  return {
    tree: (): Promise<TreeFile[]> => workspaceTree.call(session),
    readFile: (path) => readWorkspaceFile.call(session, path),
    apply: async (write, remove) => {
      const changes = {
        ...(write.length > 0 ? { write } : {}),
        ...(remove.length > 0 ? { delete: remove } : {}),
      };
      if (Object.keys(changes).length === 0) return;
      await syncWorkspace.call(session, changes);
    },
    excludedPaths: new Set([WORKSPACE_MARKER_FILENAME]),
  };
}
