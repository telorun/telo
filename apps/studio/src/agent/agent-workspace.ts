/**
 * The two surfaces a shared workspace can be reached through, behind one
 * interface so the convergence logic in `sync.ts` is written once.
 *
 * An agent reached at a user-set URL owns a directory and serves it on its own
 * `/workspace` routes. A CO-RESIDENT agent has no directory of its own: it
 * writes the session's workspace with its filesystem tools, and everything
 * outside the pod — this editor included — reaches it through the runner's
 * `/v1/sessions/:id/workspace` surface. Same directory, two ways in.
 */

import type { RunnerSession } from "../run/types";
import type { AgentClient } from "./client";
import type { AgentWorkspace, TreeFile } from "./types";

/** The kernel anchors its `.telo` cache at the directory holding this file, and
 *  a session's runner seeds one at the workspace root. It is infrastructure of
 *  the session rather than a file the user authored, so it is excluded from
 *  the sync in both directions —
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
 * A runner session's workspace, over its session routes — what the co-resident
 * agent writes with its own filesystem tools. The editor's seed, its saves and
 * an agent turn's sync all reach the files the same way, and the runner counts
 * each write as a reload cause, which it is.
 */
export function sessionWorkspace(session: RunnerSession): AgentWorkspace {
  return {
    tree: (): Promise<TreeFile[]> => session.workspaceTree(),
    readFile: (path) => session.readWorkspaceFile(path),
    apply: async (write, remove) => {
      if (write.length === 0 && remove.length === 0) return;
      await session.applyWorkspace({
        ...(write.length > 0 ? { write } : {}),
        ...(remove.length > 0 ? { delete: remove } : {}),
      });
    },
    excludedPaths: new Set([WORKSPACE_MARKER_FILENAME]),
  };
}
