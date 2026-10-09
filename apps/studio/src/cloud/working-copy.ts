import type { CommitChange, RepositoryLimits } from "./api";
import { listFilesRecursive, type ByteStore } from "./byte-store";
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

/** A commit Studio will not send because Cloud would refuse it. */
export class CommitLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitLimitError";
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** The file as text, or null when its bytes are not UTF-8. */
function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
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
    await this.store.remove(TREE_DIR);
    await this.store.makeDirectory(TREE_DIR);
    for (const entry of snapshot) {
      if (entry.kind === "file") await this.store.write(`${TREE_DIR}/${entry.path}`, entry.bytes);
    }
    await this.writeBase(branch, commit, snapshot);
  }

  /** Every difference between the working tree and the base, outside `.git`. */
  async changes(): Promise<PathChange[]> {
    const record = await this.record();
    const local = await this.localTree(record);
    const changes: PathChange[] = [];
    for (const path of new Set([...Object.keys(record.entries), ...local.keys()])) {
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
    const prepared: PreparedCommit = { changes: [], written: new Map(), deleted: [] };
    let commitBytes = 0;

    for (const path of [...new Set([...Object.keys(record.entries), ...local.keys()])].sort()) {
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
      const text = utf8Text(bytes);
      prepared.changes.push({
        op: "put",
        path,
        mode: mine.executable ? "executable" : "file",
        ...(text === null
          ? { encoding: "base64" as const, content: toBase64(bytes) }
          : { encoding: "utf8" as const, content: text }),
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
    if (local.size > limits.maxSnapshotFiles) {
      throw new CommitLimitError(
        `The workspace would hold ${local.size} files; a repository may hold at most ${limits.maxSnapshotFiles}.`,
      );
    }
    let treeBytes = 0;
    for (const [path, { size }] of local) {
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
    return { headCommit, head, plan: planMerge(base, local, await headTree(head)) };
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

  /** Drops every local change: the working tree becomes the base again. */
  async discard(): Promise<void> {
    const record = await this.record();
    await this.store.remove(TREE_DIR);
    await this.store.makeDirectory(TREE_DIR);
    for (const [path, entry] of Object.entries(record.entries)) {
      if (entry.mode === "symlink") continue;
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
