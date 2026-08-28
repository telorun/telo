import type { AgentWorkspace, TreeFile, WorkspaceBridge } from "./types";

/** Directory names excluded from two-way sync in BOTH directions: the editor's
 *  snapshot skips them, and the workspace's tree is filtered by the same list —
 *  so agent-local artifacts (e.g. the `.telo` cache `telo check` populates) are
 *  never pulled into the editor workspace, nor deleted from the workspace
 *  because the editor snapshot lacks them. */
export const SYNC_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".telo",
  ".git",
  "dist",
  // Throwaway probe manifests the agent writes to discover something and then
  // deletes. Deleting them is a prompt rule, not an enforcement, so a failed
  // turn leaves one behind — excluded here it stays out of the user's files.
  ".probes",
]);

function included(workspace: AgentWorkspace, path: string): boolean {
  if (workspace.excludedPaths.has(path)) return false;
  return !path.split("/").some((segment) => SYNC_EXCLUDED_DIRS.has(segment));
}

function includedTree(workspace: AgentWorkspace, tree: TreeFile[]): TreeFile[] {
  return tree.filter((f) => included(workspace, f.path));
}

/** The editor's snapshot, minus what this workspace does not own. Filtering the
 *  editor side by the SAME rule is what keeps a path stable: excluding it from
 *  one side only turns "leave it alone" into either a write on every turn or a
 *  delete on the first.
 *
 *  Applied here rather than trusted to the bridge's own walk. A bridge that
 *  reports a vendor directory is not a broken bridge — the exclusions are this
 *  module's rule — and a rule enforced on one side only is one a second bridge
 *  implementation silently breaks. */
function includedSnapshot(
  workspace: AgentWorkspace,
  snapshot: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, hash] of snapshot) {
    if (included(workspace, path)) out.set(path, hash);
  }
  return out;
}

/**
 * Seed the shared workspace to match the editor's, pushing exactly the
 * difference (a full seed on a fresh agent, a delta on a warm one). Diffs the
 * workspace's ACTUAL tree against the editor's file hashes: missing/changed
 * files go in `write`, files present there but gone from the editor go in
 * `delete`. Idempotent — untouched files are never disturbed, which for a
 * co-resident agent also means a turn that changes nothing causes no reload.
 */
export async function seedDelta(
  workspace: AgentWorkspace,
  bridge: WorkspaceBridge,
): Promise<void> {
  const [rawEditor, rawTree] = await Promise.all([bridge.snapshot(), workspace.tree()]);
  const editor = includedSnapshot(workspace, rawEditor);
  const remote = new Map(includedTree(workspace, rawTree).map((f) => [f.path, f.hash]));

  const write: Array<{ path: string; content: string }> = [];
  for (const [path, hash] of editor) {
    if (remote.get(path) !== hash) write.push({ path, content: await bridge.readFile(path) });
  }
  const remove: string[] = [];
  for (const path of remote.keys()) {
    if (!editor.has(path)) remove.push(path);
  }
  if (write.length || remove.length) await workspace.apply(write, remove);
}

/**
 * Reflect the shared workspace back into the editor: pull every file whose hash
 * differs (or is new) and delete files absent from its tree, all through the
 * editor's WorkspaceAdapter. Content-hash-keyed, so a replay or reconnect never
 * double-applies. This is the authoritative convergence pass run at
 * end-of-turn.
 */
export async function reconcile(
  workspace: AgentWorkspace,
  bridge: WorkspaceBridge,
): Promise<void> {
  const [rawTree, rawEditor] = await Promise.all([workspace.tree(), bridge.snapshot()]);
  const tree = includedTree(workspace, rawTree);
  const editor = includedSnapshot(workspace, rawEditor);

  const writes: Array<{ path: string; content: string }> = [];
  for (const { path, hash } of tree) {
    if (editor.get(path) !== hash) writes.push({ path, content: await workspace.readFile(path) });
  }
  const remotePaths = new Set(tree.map((f) => f.path));
  const deletes: string[] = [];
  for (const path of editor.keys()) {
    if (!remotePaths.has(path)) deletes.push(path);
  }
  if (writes.length || deletes.length) await bridge.applyChanges(writes, deletes);
}

/** Pull one file the agent just wrote (eager, mid-turn reflection). */
export async function pullFile(
  workspace: AgentWorkspace,
  bridge: WorkspaceBridge,
  path: string,
): Promise<void> {
  const content = await workspace.readFile(path);
  await bridge.applyChanges([{ path, content }], []);
}
