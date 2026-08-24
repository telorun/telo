import type { AgentClient, TreeFile } from "./client";
import type { WorkspaceBridge } from "./types";

/** Directory names excluded from two-way sync in BOTH directions: the editor's
 *  snapshot skips them, and the agent's tree is filtered by the same list — so
 *  agent-local artifacts (e.g. the `.telo` cache `telo check` populates) are
 *  never pulled into the editor workspace, nor deleted from the agent because
 *  the editor snapshot lacks them. */
export const SYNC_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".telo",
  ".git",
  "dist",
]);

function includedTree(tree: TreeFile[]): TreeFile[] {
  return tree.filter(
    (f) => !f.path.split("/").some((segment) => SYNC_EXCLUDED_DIRS.has(segment)),
  );
}

/**
 * Seed the agent's workspace to match the editor's, pushing exactly the
 * difference (a full seed on a fresh agent, a delta on a warm one). Diffs the
 * agent's ACTUAL tree against the editor's file hashes: missing/changed files
 * go in `write`, files present on the agent but gone from the editor go in
 * `delete`. Idempotent — untouched files are never disturbed.
 */
export async function seedDelta(client: AgentClient, bridge: WorkspaceBridge): Promise<void> {
  const [editor, agentTree] = await Promise.all([bridge.snapshot(), client.workspaceTree()]);
  const agent = new Map(includedTree(agentTree).map((f) => [f.path, f.hash]));

  const write: Array<{ path: string; content: string }> = [];
  for (const [path, hash] of editor) {
    if (agent.get(path) !== hash) write.push({ path, content: await bridge.readFile(path) });
  }
  const del: string[] = [];
  for (const path of agent.keys()) {
    if (!editor.has(path)) del.push(path);
  }
  if (write.length || del.length) await client.syncWorkspace(write, del);
}

/**
 * Reflect the agent's workspace back into the editor: pull every file whose
 * hash differs (or is new) and delete files absent from the agent tree, all
 * through the editor's WorkspaceAdapter. Content-hash-keyed, so a replay or
 * reconnect never double-applies. This is the authoritative convergence pass
 * run at end-of-turn.
 */
export async function reconcile(client: AgentClient, bridge: WorkspaceBridge): Promise<void> {
  const [rawTree, editor] = await Promise.all([client.workspaceTree(), bridge.snapshot()]);
  const agentTree = includedTree(rawTree);

  const writes: Array<{ path: string; content: string }> = [];
  for (const { path, hash } of agentTree) {
    if (editor.get(path) !== hash) writes.push({ path, content: await client.readWorkspaceFile(path) });
  }
  const agentPaths = new Set(agentTree.map((f) => f.path));
  const deletes: string[] = [];
  for (const path of editor.keys()) {
    if (!agentPaths.has(path)) deletes.push(path);
  }
  if (writes.length || deletes.length) await bridge.applyChanges(writes, deletes);
}

/** Pull one file the agent just wrote (eager, mid-turn reflection). */
export async function pullFile(client: AgentClient, bridge: WorkspaceBridge, path: string): Promise<void> {
  const content = await client.readWorkspaceFile(path);
  await bridge.applyChanges([{ path, content }], []);
}
