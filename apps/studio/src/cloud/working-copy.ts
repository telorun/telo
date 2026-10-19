import { classifySensitiveEnvFiles, type EnvFileRead, type ReadEnvFile } from "@telorun/analyzer";
import { encodeFileContent } from "../file-content-encoding";
import type { CommitChange, RepositoryLimits } from "./api";
import { FileNotFoundError, listFilesRecursive, type ByteStore } from "./byte-store";
import type { SnapshotEntry } from "./snapshot-tar";
import { planMerge, sameState, type MergePlan, type PathState } from "./three-way-merge";

/** The working tree: what the rest of Studio reads and writes. */
export const TREE_DIR = "tree";
/** An untouched copy of the base snapshot's files. */
const BASE_DIR = "base";
const RECORD_FILE = "base.json";

type BaseEntry =
  | { mode: "file" | "executable"; sha256: string }
  | { mode: "symlink"; target: string };

/** What the working copy was last in step with. Modes and link targets live
 *  here because neither store can hold them on every platform. */
interface BaseRecord {
  version: 1;
  branch: string;
  /** Null: the branch has no commit yet. */
  commit: string | null;
  entries: Record<string, BaseEntry>;
}

export interface PathChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

/** A commit as it will be sent, with what the base becomes once it lands. */
export interface PreparedCommit {
  changes: CommitChange[];
  written: Map<string, { bytes: Uint8Array; sha256: string; executable: boolean }>;
  deleted: string[];
}

export interface PreparedUpdate {
  headCommit: string | null;
  head: SnapshotEntry[];
  plan: MergePlan;
}

/** A file to copy into the working tree, by path relative to its root. */
export interface ImportFile {
  path: string;
  bytes: Uint8Array;
}

/** A copy into the working tree as it will be written. */
export interface PreparedImport {
  /** The files that differ from the working tree. */
  files: ImportFile[];
  /** The paths among them the working tree already holds. */
  overwrites: string[];
}

/** A commit Studio will not send because Cloud would refuse it. */
export class CommitLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitLimitError";
  }
}

/** A file that cannot be copied in: the working tree holds a directory where
 *  it would be a file, or a file where it needs a directory. */
export class ImportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportPathError";
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}


/** A path relative to a store directory, read as the classifier reads it. */
function storeRead(store: ByteStore, directory: string): ReadEnvFile {
  return async (path): Promise<EnvFileRead> => {
    try {
      return { kind: "text", text: new TextDecoder().decode(await store.read(`${directory}/${path}`)) };
    } catch (error) {
      if (!(error instanceof FileNotFoundError)) {
        return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
      }
      return (await store.exists(`${directory}/${path}`)) ? { kind: "not-a-file" } : { kind: "missing" };
    }
  };
}

function snapshotRead(snapshot: SnapshotEntry[]): ReadEnvFile {
  const files = new Map(snapshot.flatMap((entry) => (entry.kind === "file" ? [[entry.path, entry.bytes]] : [])));
  return async (path) => {
    const bytes = files.get(path);
    return bytes ? { kind: "text", text: new TextDecoder().decode(bytes) } : { kind: "missing" };
  };
}

/** The sensitive env files among `paths`, each governed by the nearest
 *  `telo-workspace.yaml` that `read` finds at or above it. A marker that cannot
 *  be read, or whose `env:` is refused, refuses the operation with its message:
 *  deciding without it could send a secret to the repository. */
async function sensitivePaths(paths: Iterable<string>, read: ReadEnvFile): Promise<ReadonlySet<string>> {
  const answer = await classifySensitiveEnvFiles([...new Set(paths)], read);
  if ("failed" in answer) throw new Error(answer.failed);
  return answer.sensitive;
}

/** The sensitive env files among `paths` by the markers of what is about to be
 *  written. Markers that cannot be classified mark nothing: the working tree's
 *  own markers still decide what is kept, and a broken marker in a snapshot must
 *  not lock the project out of the editor. */
async function incomingSensitive(paths: Iterable<string>, read: ReadEnvFile): Promise<ReadonlySet<string>> {
  const answer = await classifySensitiveEnvFiles([...new Set(paths)], read);
  return "failed" in answer ? new Set() : answer.sensitive;
}

function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function stateOf(entry: BaseEntry | undefined): PathState {
  if (!entry) return null;
  if (entry.mode === "symlink") return { kind: "symlink", target: entry.target };
  return { kind: "file", sha256: entry.sha256, executable: entry.mode === "executable" };
}

function entryOf(state: Exclude<PathState, null>): BaseEntry {
  if (state.kind === "symlink") return { mode: "symlink", target: state.target };
  return { mode: state.executable ? "executable" : "file", sha256: state.sha256 };
}

/**
 * One Cloud project on this device: the working tree, an untouched copy of
 * the snapshot it was based on, and that snapshot's commit. Everything is
 * decided on bytes — the editor above reads files as text, which says nothing
 * about a binary one.
 *
 * A sensitive env file is outside version control on every side: it is left
 * out of the base, the working tree and the head alike when changes are
 * listed or committed, so a secret committed before its file was marked stays
 * as it is in the repository and never shows as changed or deleted. Which files
 * are sensitive is the working tree's markers' answer, and a marker among them
 * that cannot be classified refuses every operation with its message.
 *
 * Seeding, discarding and updating replace the tree with incoming files (the
 * snapshot, the base, the head) and leave a tree file untouched when the
 * tree's markers or the incoming markers mark it; an incoming file is written
 * unless its path is left alone or the incoming markers mark it, and an
 * update's merge leaves every such path out. Incoming markers that cannot be
 * classified mark nothing. A file left alone only by the markers being
 * replaced is an ordinary file afterwards and may show as a change.
 *
 * Callers serialize: no two of these methods run at once on one working copy.
 */
export class WorkingCopy {
  constructor(private readonly store: ByteStore) {}

  exists(): Promise<boolean> {
    return this.store.exists(RECORD_FILE);
  }

  async branch(): Promise<string> {
    return (await this.record()).branch;
  }

  async baseCommit(): Promise<string | null> {
    return (await this.record()).commit;
  }

  /** Replaces everything with a snapshot: the first open, and a branch switch. */
  async seed(branch: string, commit: string | null, snapshot: SnapshotEntry[]): Promise<void> {
    const { keep, skip } = await this.leftAlone(
      snapshot.map((entry) => entry.path),
      snapshotRead(snapshot),
    );
    await this.clearTreeExcept(keep);
    for (const entry of snapshot) {
      if (entry.kind !== "file" || skip.has(entry.path)) continue;
      await this.store.write(`${TREE_DIR}/${entry.path}`, entry.bytes);
    }
    await this.writeBase(branch, commit, snapshot);
  }

  /** Every difference between the working tree and the base, outside `.git`
   *  and the sensitive env files. */
  async changes(): Promise<PathChange[]> {
    const record = await this.record();
    const local = await this.localTree(record);
    const paths = new Set([...Object.keys(record.entries), ...local.keys()]);
    const sensitive = await this.sensitiveInTree(paths);
    const changes: PathChange[] = [];
    for (const path of paths) {
      if (sensitive.has(path)) continue;
      const base = stateOf(record.entries[path]);
      const mine = local.get(path)?.state ?? null;
      if (sameState(base, mine)) continue;
      changes.push({
        path,
        status: mine === null ? "deleted" : base === null ? "added" : "modified",
      });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Reads what a commit would send, and refuses — naming the file — what
   *  Cloud's limits would refuse. */
  async prepareCommit(limits: RepositoryLimits): Promise<PreparedCommit> {
    const record = await this.record();
    const local = await this.localTree(record);
    const paths = new Set([...Object.keys(record.entries), ...local.keys()]);
    const sensitive = await this.sensitiveInTree(paths);
    const prepared: PreparedCommit = { changes: [], written: new Map(), deleted: [] };
    let commitBytes = 0;

    for (const path of [...paths].sort()) {
      if (sensitive.has(path)) continue;
      const base = stateOf(record.entries[path]);
      const mine = local.get(path)?.state ?? null;
      if (sameState(base, mine)) continue;
      if (mine === null) {
        prepared.changes.push({ op: "delete", path });
        prepared.deleted.push(path);
        continue;
      }
      // A link is never the working tree's to change, so what differs is a file.
      if (mine.kind !== "file") continue;
      const bytes = await this.store.read(`${TREE_DIR}/${path}`);
      if (bytes.length > limits.maxFileBytes) {
        throw new CommitLimitError(
          `${path} is ${mebibytes(bytes.length)}; a file may be at most ${mebibytes(limits.maxFileBytes)}.`,
        );
      }
      commitBytes += bytes.length;
      if (commitBytes > limits.maxCommitBytes) {
        throw new CommitLimitError(
          `This commit exceeds ${mebibytes(limits.maxCommitBytes)} at ${path}. Commit fewer files at a time.`,
        );
      }
      prepared.changes.push({
        op: "put",
        path,
        mode: mine.executable ? "executable" : "file",
        ...encodeFileContent(bytes),
      });
      prepared.written.set(path, {
        bytes,
        sha256: await sha256Hex(bytes),
        executable: mine.executable,
      });
    }

    if (prepared.changes.length > limits.maxCommitChanges) {
      throw new CommitLimitError(
        `This commit changes ${prepared.changes.length} files; a commit may change at most ${limits.maxCommitChanges}.`,
      );
    }
    const repository = await this.repositoryTree(record, local, sensitive);
    if (repository.size > limits.maxSnapshotFiles) {
      throw new CommitLimitError(
        `The workspace would hold ${repository.size} files; a repository may hold at most ${limits.maxSnapshotFiles}.`,
      );
    }
    let treeBytes = 0;
    for (const [path, size] of repository) {
      treeBytes += size;
      if (treeBytes > limits.maxSnapshotBytes) {
        throw new CommitLimitError(
          `The workspace exceeds ${mebibytes(limits.maxSnapshotBytes)} at ${path}.`,
        );
      }
    }
    return prepared;
  }

  /** The commit landed: its tree is the new base. */
  async recordCommit(commit: string, prepared: PreparedCommit): Promise<void> {
    const record = await this.record();
    for (const [path, file] of prepared.written) {
      await this.store.write(`${BASE_DIR}/${path}`, file.bytes);
      record.entries[path] = {
        mode: file.executable ? "executable" : "file",
        sha256: file.sha256,
      };
    }
    for (const path of prepared.deleted) {
      await this.store.remove(`${BASE_DIR}/${path}`);
      delete record.entries[path];
    }
    record.commit = commit;
    await this.saveRecord(record);
  }

  /** Compares base, local and the head's snapshot per path. Changes nothing. */
  async prepareUpdate(headCommit: string | null, head: SnapshotEntry[]): Promise<PreparedUpdate> {
    const record = await this.record();
    const base = new Map(Object.entries(record.entries).map(([p, e]) => [p, stateOf(e)]));
    const local = new Map([...(await this.localTree(record))].map(([p, f]) => [p, f.state]));
    const theirs = await headTree(head);
    const paths = [...base.keys(), ...local.keys(), ...theirs.keys()];
    const byTree = await this.sensitiveInTree(paths);
    const byHead = await incomingSensitive(paths, snapshotRead(head));
    const shared = <T,>(tree: Map<string, T>) =>
      new Map([...tree].filter(([path]) => !byTree.has(path) && !byHead.has(path)));
    return { headCommit, head, plan: planMerge(shared(base), shared(local), shared(theirs)) };
  }

  /**
   * Brings the working copy onto the head: paths only the head changed take
   * the head's state, each conflict takes the head's when its path is in
   * `theirs` and keeps the working tree's otherwise. The head becomes the base
   * and nothing is committed.
   */
  async applyUpdate(update: PreparedUpdate, theirs: ReadonlySet<string>): Promise<string[]> {
    const record = await this.record();
    const headByPath = new Map(update.head.map((entry) => [entry.path, entry]));
    const taken = [...update.plan.takeHead, ...update.plan.conflicts.filter((p) => theirs.has(p))];
    // The tree first: stopped here, what it took equals the head, so the next
    // update settles those paths by itself.
    for (const path of taken) {
      const entry = headByPath.get(path);
      if (entry?.kind === "file") await this.store.write(`${TREE_DIR}/${path}`, entry.bytes);
      else await this.store.remove(`${TREE_DIR}/${path}`);
    }
    await this.writeBase(record.branch, update.headCommit, update.head);
    return taken;
  }

  /**
   * Reads what copying `files` into the working tree would write, and refuses —
   * naming the file — what could not be written or what Cloud's limits would
   * refuse of the commit that follows. Changes nothing. Meant for a clean
   * working copy, where what it writes is the whole of that commit.
   */
  async prepareImport(files: ImportFile[], limits: RepositoryLimits): Promise<PreparedImport> {
    const record = await this.record();
    const local = await this.localTree(record);
    const sensitive = await this.sensitiveInTree([...local.keys(), ...files.map((file) => file.path)]);
    const directories = new Set<string>();
    for (const path of local.keys()) {
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join("/"));
    }

    const prepared: PreparedImport = { files: [], overwrites: [] };
    const sizes = await this.repositoryTree(record, local, sensitive);
    let commitBytes = 0;
    for (const file of files) {
      const { path, bytes } = file;
      if (sensitive.has(path)) {
        throw new ImportPathError(
          `${path} cannot be copied: it is a sensitive env file in the project (by its nearest telo-workspace.yaml, or .env.local where none governs), so it is kept out of the repository.`,
        );
      }
      if (directories.has(path)) {
        throw new ImportPathError(`${path} cannot be copied: the project holds a directory there.`);
      }
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++) {
        const parent = segments.slice(0, i).join("/");
        if (local.has(parent)) {
          throw new ImportPathError(`${path} cannot be copied: the project holds a file at ${parent}.`);
        }
      }
      if (bytes.length > limits.maxFileBytes) {
        throw new CommitLimitError(
          `${path} is ${mebibytes(bytes.length)}; a file may be at most ${mebibytes(limits.maxFileBytes)}.`,
        );
      }
      const existing = local.get(path)?.state;
      if (existing?.kind === "file" && existing.sha256 === (await sha256Hex(bytes))) continue;
      commitBytes += bytes.length;
      if (commitBytes > limits.maxCommitBytes) {
        throw new CommitLimitError(
          `Copying these files exceeds ${mebibytes(limits.maxCommitBytes)} for one commit at ${path}.`,
        );
      }
      prepared.files.push(file);
      if (existing) prepared.overwrites.push(path);
      sizes.set(path, bytes.length);
    }

    if (prepared.files.length > limits.maxCommitChanges) {
      throw new CommitLimitError(
        `Copying would change ${prepared.files.length} files; a commit may change at most ${limits.maxCommitChanges}.`,
      );
    }
    if (sizes.size > limits.maxSnapshotFiles) {
      throw new CommitLimitError(
        `The project would hold ${sizes.size} files; a repository may hold at most ${limits.maxSnapshotFiles}.`,
      );
    }
    let treeBytes = 0;
    for (const [path, size] of sizes) {
      treeBytes += size;
      if (treeBytes > limits.maxSnapshotBytes) {
        throw new CommitLimitError(
          `The project would exceed ${mebibytes(limits.maxSnapshotBytes)} at ${path}.`,
        );
      }
    }
    return prepared;
  }

  /** Writes a prepared copy into the working tree. Nothing is committed. */
  async applyImport(prepared: PreparedImport): Promise<void> {
    for (const file of prepared.files) {
      await this.store.write(`${TREE_DIR}/${file.path}`, file.bytes);
    }
  }

  /** Drops every local change: the working tree becomes the base again. */
  async discard(): Promise<void> {
    const record = await this.record();
    const { keep, skip } = await this.leftAlone(Object.keys(record.entries), storeRead(this.store, BASE_DIR));
    await this.clearTreeExcept(keep);
    for (const [path, entry] of Object.entries(record.entries)) {
      if (entry.mode === "symlink" || skip.has(path)) continue;
      await this.store.write(`${TREE_DIR}/${path}`, await this.store.read(`${BASE_DIR}/${path}`));
    }
  }

  /** Continues on another branch at the same base commit (a branch just
   *  created from it). */
  async setBranch(branch: string): Promise<void> {
    await this.saveRecord({ ...(await this.record()), branch });
  }

  /** Removes the working copy from the device. */
  remove(): Promise<void> {
    return this.store.remove("");
  }

  /** The sensitive env files among `paths`, by the working tree's markers. */
  private sensitiveInTree(paths: Iterable<string>): Promise<ReadonlySet<string>> {
    return sensitivePaths(paths, storeRead(this.store, TREE_DIR));
  }

  /** What replacing the working tree with `incoming` (read through `read`)
   *  leaves alone: `keep`, the tree's files sensitive by its own markers or by
   *  the incoming ones, and `skip`, those plus every incoming file the incoming
   *  markers mark. Refuses when the tree's own markers cannot be classified. */
  private async leftAlone(
    incoming: string[],
    read: ReadEnvFile,
  ): Promise<{ keep: ReadonlySet<string>; skip: ReadonlySet<string> }> {
    const tree = await listFilesRecursive(this.store, TREE_DIR);
    const byTree = await this.sensitiveInTree(tree);
    const byIncoming = await incomingSensitive([...tree, ...incoming], read);
    const keep = new Set(tree.filter((path) => byTree.has(path) || byIncoming.has(path)));
    return { keep, skip: new Set([...keep, ...byIncoming]) };
  }

  /** Empties the working tree of everything but `keep`, and of the directories
   *  that held nothing else. */
  private async clearTreeExcept(keep: ReadonlySet<string>): Promise<void> {
    if (keep.size === 0) {
      await this.store.remove(TREE_DIR);
      await this.store.makeDirectory(TREE_DIR);
      return;
    }
    const clear = async (directory: string, relative: string): Promise<boolean> => {
      let kept = false;
      for (const entry of await this.store.list(directory)) {
        const child = `${directory}/${entry.name}`;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory ? await clear(child, childRelative) : keep.has(childRelative)) kept = true;
        else await this.store.remove(child);
      }
      return kept;
    };
    await clear(TREE_DIR, "");
  }

  /** The repository's files after a commit of this working tree, with their
   *  sizes: the tree's files outside the sensitive ones, and those the base
   *  holds at a sensitive path, which no commit changes. */
  private async repositoryTree(
    record: BaseRecord,
    local: Map<string, { state: Exclude<PathState, null>; size: number }>,
    sensitive: ReadonlySet<string>,
  ): Promise<Map<string, number>> {
    const tree = new Map([...local].flatMap(([path, file]) => (sensitive.has(path) ? [] : [[path, file.size] as const])));
    for (const path of sensitive) {
      const entry = record.entries[path];
      if (!entry) continue;
      tree.set(path, entry.mode === "symlink" ? 0 : (await this.store.read(`${BASE_DIR}/${path}`)).length);
    }
    return tree;
  }

  private async record(): Promise<BaseRecord> {
    const record = JSON.parse(new TextDecoder().decode(await this.store.read(RECORD_FILE))) as BaseRecord;
    if (record.version !== 1) {
      throw new Error("This working copy was written by a Studio this one cannot read.");
    }
    return record;
  }

  private saveRecord(record: BaseRecord): Promise<void> {
    return this.store.write(RECORD_FILE, new TextEncoder().encode(JSON.stringify(record)));
  }

  private async writeBase(
    branch: string,
    commit: string | null,
    snapshot: SnapshotEntry[],
  ): Promise<void> {
    await this.store.remove(BASE_DIR);
    const entries: Record<string, BaseEntry> = {};
    for (const [path, state] of await headTree(snapshot)) {
      entries[path] = entryOf(state);
    }
    for (const entry of snapshot) {
      if (entry.kind === "file") await this.store.write(`${BASE_DIR}/${entry.path}`, entry.bytes);
    }
    await this.saveRecord({ version: 1, branch, commit, entries });
  }

  /** The working tree as states. A file keeps the mode its base records, and a
   *  link the tree does not cover is still there: the tree holds no links. */
  private async localTree(
    record: BaseRecord,
  ): Promise<Map<string, { state: Exclude<PathState, null>; size: number }>> {
    const local = new Map<string, { state: Exclude<PathState, null>; size: number }>();
    for (const path of await listFilesRecursive(this.store, TREE_DIR)) {
      if (path.split("/").includes(".git")) continue;
      const bytes = await this.store.read(`${TREE_DIR}/${path}`);
      local.set(path, {
        state: {
          kind: "file",
          sha256: await sha256Hex(bytes),
          executable: record.entries[path]?.mode === "executable",
        },
        size: bytes.length,
      });
    }
    for (const [path, entry] of Object.entries(record.entries)) {
      if (entry.mode === "symlink" && !local.has(path)) {
        local.set(path, { state: { kind: "symlink", target: entry.target }, size: 0 });
      }
    }
    return local;
  }
}

async function headTree(snapshot: SnapshotEntry[]): Promise<Map<string, Exclude<PathState, null>>> {
  const tree = new Map<string, Exclude<PathState, null>>();
  for (const entry of snapshot) {
    tree.set(
      entry.path,
      entry.kind === "symlink"
        ? { kind: "symlink", target: entry.target }
        : { kind: "file", sha256: await sha256Hex(entry.bytes), executable: entry.executable },
    );
  }
  return tree;
}
