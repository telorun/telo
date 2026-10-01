import type { ResourceInstance } from "@telorun/sdk";
import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import {
  FsManifest,
  resolveBase,
  resolveTarget,
  toManifestPath,
  wrapFsError,
} from "./fs-support.js";
import { comparePaths } from "./path-order.js";

interface TreeSnapshotInput {
  paths?: string[];
  exclude?: string[];
}

interface FileHash {
  path: string;
  hash: string;
  size: number;
}

interface TreeSnapshotResult {
  files: FileHash[];
  missing: string[];
}

type Stats = Awaited<ReturnType<typeof lstat>>;

/** A content-hash walk of the requested roots: every regular file at or under
 *  one as `{ path (relative to the base), hash (sha256 hex of its bytes), size }`,
 *  and the roots that do not exist as `missing`. Unlike Fs.DirectoryListing's
 *  size, a content hash is a reliable change detector, so a consumer can diff two
 *  trees to compute an exact write/delete set. */
class TreeSnapshotResource implements ResourceInstance<TreeSnapshotInput, TreeSnapshotResult> {
  constructor(private readonly base: string) {}

  async invoke(input: TreeSnapshotInput): Promise<TreeSnapshotResult> {
    const exclude = new Set(input?.exclude ?? []);
    // Keyed by path, so a file two roots both reach is reported once.
    const files = new Map<string, FileHash>();
    const missing: string[] = [];
    if (input?.paths === undefined) {
      await this.walk(this.base, exclude, files);
    } else {
      for (const requested of input.paths) {
        const root = requested === "" ? this.base : resolveTarget(this.base, requested);
        const stats = await this.statRoot(root);
        if (!stats) missing.push(requested);
        else if (stats.isDirectory()) await this.walk(root, exclude, files);
        else if (stats.isFile()) await this.hash(root, files);
      }
    }
    return {
      files: [...files.values()].sort((a, b) => comparePaths(a.path, b.path)),
      missing,
    };
  }

  /** A root's stats, or undefined when nothing exists there. lstat, not stat —
   *  a symlink is not followed, so a root that is one contributes nothing. */
  private async statRoot(root: string): Promise<Stats | undefined> {
    try {
      return await lstat(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw wrapFsError("Fs.TreeSnapshot: cannot stat", root, err);
    }
  }

  private async hash(file: string, out: Map<string, FileHash>): Promise<void> {
    const relative = toManifestPath(this.base, file);
    if (out.has(relative)) return;
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (err) {
      throw wrapFsError("Fs.TreeSnapshot: cannot read", file, err);
    }
    out.set(relative, {
      path: relative,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    });
  }

  private async walk(dir: string, exclude: Set<string>, out: Map<string, FileHash>): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      throw wrapFsError("Fs.TreeSnapshot: cannot list", dir, err);
    }
    for (const name of names) {
      if (exclude.has(name)) continue;
      const full = path.join(dir, name);
      // lstat, not stat — a symlink is not followed (reported as neither file
      // nor directory, so skipped) to keep the walk inside the tree.
      let stats: Stats;
      try {
        stats = await lstat(full);
      } catch (err) {
        throw wrapFsError("Fs.TreeSnapshot: cannot stat", full, err);
      }
      if (stats.isDirectory()) await this.walk(full, exclude, out);
      else if (stats.isFile()) await this.hash(full, out);
    }
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<TreeSnapshotResource> {
  return new TreeSnapshotResource(resolveBase(resource.cwd));
}
