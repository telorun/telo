import type { ResourceInstance } from "@telorun/sdk";
import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { FsManifest, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface TreeSnapshotInput {
  path?: string;
  exclude?: string[];
}

interface FileHash {
  path: string;
  hash: string;
}

interface TreeSnapshotResult {
  files: FileHash[];
}

/** A recursive content-hash walk: every regular file under the root as
 *  `{ path (relative to the base), hash (sha256 hex of its bytes) }`. Unlike
 *  Fs.DirectoryListing's size, a content hash is a reliable change detector, so
 *  a consumer can diff two trees to compute an exact write/delete set. */
class TreeSnapshotResource implements ResourceInstance<TreeSnapshotInput, TreeSnapshotResult> {
  constructor(private readonly base: string) {}

  async invoke(input: TreeSnapshotInput): Promise<TreeSnapshotResult> {
    const root = input?.path ? resolveTarget(this.base, input.path) : this.base;
    const exclude = new Set(input?.exclude ?? []);
    const files: FileHash[] = [];
    await this.walk(root, exclude, files);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files };
  }

  private async walk(dir: string, exclude: Set<string>, out: FileHash[]): Promise<void> {
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
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(full);
      } catch (err) {
        throw wrapFsError("Fs.TreeSnapshot: cannot stat", full, err);
      }
      if (stats.isDirectory()) {
        await this.walk(full, exclude, out);
      } else if (stats.isFile()) {
        let bytes: Buffer;
        try {
          bytes = await readFile(full);
        } catch (err) {
          throw wrapFsError("Fs.TreeSnapshot: cannot read", full, err);
        }
        out.push({
          path: path.relative(this.base, full),
          hash: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<TreeSnapshotResource> {
  return new TreeSnapshotResource(resolveBase(resource.cwd));
}
