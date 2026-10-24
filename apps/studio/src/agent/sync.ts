import { classifySensitiveEnvFiles, WORKSPACE_FILENAME } from "@telorun/analyzer";
import { encodeFileContent } from "../file-content-encoding";
import type { AgentWorkspace, TreeFile, WorkspaceBridge, WorkspaceWrite } from "./types";

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
  // The agent's own state (its database). Pulled in, it would be edited as
  // project files; pushed back, the editor's stale copy would overwrite it.
  ".telo-agent",
]);

function inExcludedDir(path: string): boolean {
  return path.split("/").some((segment) => SYNC_EXCLUDED_DIRS.has(segment));
}

/** The one inclusion rule, in both directions: a path is shared unless the
 *  workspace owns it, it lies in an excluded directory, or it is a sensitive
 *  env file — values that must not leave the editor's machine. */
function included(
  workspace: Pick<AgentWorkspace, "excludedPaths">,
  sensitive: ReadonlySet<string>,
  path: string,
): boolean {
  return !workspace.excludedPaths.has(path) && !sensitive.has(path) && !inExcludedDir(path);
}

/**
 * The sensitive env files among `paths`, each governed by the nearest
 * `telo-workspace.yaml` the EDITOR holds at or above it — a file the agent's
 * side holds is classified by the editor's markers too, so one rule decides
 * both directions. Computed on every pass, since a marker or a file may have
 * changed since the last. A marker that cannot be read, or whose `env:` is
 * refused, refuses the pass with its message: syncing without it could copy a
 * secret into the session.
 */
async function sensitiveFiles(bridge: WorkspaceBridge, paths: Iterable<string>): Promise<ReadonlySet<string>> {
  const candidates = [...new Set(paths)].filter((path) => !inExcludedDir(path));
  const answer = await classifySensitiveEnvFiles(candidates, (path) => bridge.probeFile(path));
  if ("failed" in answer) throw new Error(answer.failed);
  return answer.sensitive;
}

function includedTree(
  workspace: AgentWorkspace,
  sensitive: ReadonlySet<string>,
  tree: TreeFile[],
): TreeFile[] {
  return tree.filter((f) => included(workspace, sensitive, f.path));
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
  sensitive: ReadonlySet<string>,
  snapshot: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, hash] of snapshot) {
    if (included(workspace, sensitive, path)) out.set(path, hash);
  }
  return out;
}

/** What one pass shares of the two sides, and the sensitive files it left out. */
async function sharedSides(
  workspace: AgentWorkspace,
  bridge: WorkspaceBridge,
  rawEditor: Map<string, string>,
  rawTree: TreeFile[],
): Promise<{ editor: Map<string, string>; tree: TreeFile[]; sensitive: ReadonlySet<string> }> {
  const sensitive = await sensitiveFiles(bridge, [...rawEditor.keys(), ...rawTree.map((f) => f.path)]);
  return {
    editor: includedSnapshot(workspace, sensitive, rawEditor),
    tree: includedTree(workspace, sensitive, rawTree),
    sensitive,
  };
}

/**
 * Seed the shared workspace to match the editor's, pushing exactly the
 * difference (a full seed on a fresh agent, a delta on a warm one). Diffs the
 * workspace's ACTUAL tree against the editor's file hashes: missing/changed
 * files go in `write`, files present there but gone from the editor go in
 * `delete`. Idempotent — untouched files are never disturbed, which for a
 * co-resident agent also means a turn that changes nothing causes no reload.
 * A file is written byte for byte: one that is not UTF-8 travels as base64.
 * Resolves with the sensitive env files the pass left out.
 */
export async function seedDelta(
  workspace: AgentWorkspace,
  bridge: WorkspaceBridge,
): Promise<ReadonlySet<string>> {
  const [rawEditor, rawTree] = await Promise.all([bridge.snapshot(), workspace.tree()]);
  const { editor, tree, sensitive } = await sharedSides(workspace, bridge, rawEditor, rawTree);
  const remote = new Map(tree.map((f) => [f.path, f.hash]));

  const write: WorkspaceWrite[] = [];
  for (const [path, hash] of editor) {
    if (remote.get(path) === hash) continue;
    const { content, encoding } = encodeFileContent(await bridge.readBytes(path));
    write.push({ path, content, ...(encoding === "base64" ? { encoding } : {}) });
  }
  const remove: string[] = [];
  for (const path of remote.keys()) {
    if (!editor.has(path)) remove.push(path);
  }
  if (write.length || remove.length) await workspace.apply(write, remove);
  return sensitive;
}

/**
 * Reflect the shared workspace back into the editor: pull every file whose hash
 * differs (or is new) and delete files absent from its tree, all through the
 * editor's WorkspaceAdapter. Content-hash-keyed, so a replay or reconnect never
 * double-applies. This is the authoritative convergence pass run at
 * end-of-turn. Resolves with the sensitive env files the pass left out.
 */
export async function reconcile(
  workspace: AgentWorkspace,
  bridge: WorkspaceBridge,
): Promise<ReadonlySet<string>> {
  const [rawTree, rawEditor] = await Promise.all([workspace.tree(), bridge.snapshot()]);
  const { editor, tree, sensitive } = await sharedSides(workspace, bridge, rawEditor, rawTree);

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
  return sensitive;
}

/** Pull one file the agent just wrote (eager, mid-turn reflection) — unless
 *  the inclusion rule leaves it out. Only the markers above the path are read,
 *  since only they can govern it. */
export async function pullFile(
  workspace: AgentWorkspace,
  bridge: WorkspaceBridge,
  path: string,
): Promise<void> {
  const segments = path.split("/");
  const markers = segments.map((_, depth) =>
    [...segments.slice(0, depth), WORKSPACE_FILENAME].join("/"),
  );
  const sensitive = await sensitiveFiles(bridge, [path, ...markers]);
  if (!included(workspace, sensitive, path)) return;
  const content = await workspace.readFile(path);
  await bridge.applyChanges([{ path, content }], []);
}

/** The editor's file for a path the agent named, or null when the path names
 *  none: one the two sides do not share is refused here, before the bridge is
 *  asked — the exclusions are this module's rule, never the bridge's.
 *  `sensitive` is what the last pass left out. */
export function sharedEditorFile(
  workspace: Pick<AgentWorkspace, "excludedPaths">,
  bridge: WorkspaceBridge,
  path: string,
  sensitive: ReadonlySet<string>,
): string | null {
  return included(workspace, sensitive, path) ? bridge.editorFile(path) : null;
}

/** A reverted turn: each path its recorded revert marks restored, with the
 *  digests the turn's summary records for it (null: no file). */
export interface RevertedTurn {
  turnId: string;
  files: Array<{ path: string; before: string | null; after: string | null }>;
}

/**
 * Bring the editor's copies in line with reverts the agent recorded, whoever
 * asked for them. What licenses changing an editor file is three facts about
 * its path together — the recorded revert marks it restored (the only paths a
 * `RevertedTurn` carries), the workspace's tree now holds `before` there, and
 * the editor's copy is byte-identical to `after` — with nothing remembered
 * about earlier syncs:
 *
 * - the workspace does not hold `before` — nothing, and nothing reported: the
 *   revert is no longer what the workspace holds;
 * - the editor holds `before` — nothing: already in line;
 * - the editor holds `after` — the workspace's content replaces it, or it is
 *   deleted when the turn had created it;
 * - the editor holds anything else — an edit the workspace never saw: left, and
 *   the path reported as kept, under its turn.
 *
 * A null `before` is held where the tree has no such path, whether it holds
 * other files or none. A tree that cannot be read rejects: it is never taken
 * for an empty one. One snapshot and one tree, however many turns.
 */
export async function applyReverted(
  workspace: AgentWorkspace,
  bridge: WorkspaceBridge,
  turns: RevertedTurn[],
): Promise<Map<string, string[]>> {
  const kept = new Map<string, string[]>(turns.map((turn) => [turn.turnId, []]));
  const [rawTree, rawEditor] = await Promise.all([workspace.tree(), bridge.snapshot()]);
  const shared = await sharedSides(workspace, bridge, rawEditor, rawTree);
  const tree = new Map(shared.tree.map((f) => [f.path, f.hash]));
  const { editor, sensitive } = shared;

  const writes = new Map<string, string>();
  const deletes = new Set<string>();
  for (const turn of turns) {
    for (const { path, before, after } of turn.files) {
      if (!included(workspace, sensitive, path) || (tree.get(path) ?? null) !== before) continue;
      const local = editor.get(path) ?? null;
      if (local === before) continue;
      if (local !== after) {
        kept.get(turn.turnId)?.push(path);
      } else if (before === null) {
        writes.delete(path);
        deletes.add(path);
        editor.delete(path);
      } else {
        deletes.delete(path);
        writes.set(path, await workspace.readFile(path));
        editor.set(path, before);
      }
    }
  }
  if (writes.size || deletes.size) {
    await bridge.applyChanges(
      [...writes].map(([path, content]) => ({ path, content })),
      [...deletes],
    );
  }
  return kept;
}
