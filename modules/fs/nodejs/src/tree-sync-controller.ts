import type { ResourceInstance } from "@telorun/sdk";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface WriteItem {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

interface TreeSyncInput {
  write?: WriteItem[];
  delete?: string[];
}

interface TreeSyncResult {
  written: number;
  deleted: number;
}

/** Apply an EXPLICIT change set to a tree: write each listed file (creating
 *  parents) and remove each deleted path. It does not implicitly delete files
 *  absent from the set, so one operation serves both a full seed (all files,
 *  empty `delete`) and a partial delta (only what changed) without disturbing
 *  untouched files. */
class TreeSyncResource implements ResourceInstance<TreeSyncInput, TreeSyncResult> {
  constructor(private readonly base: string) {}

  async invoke(input: TreeSyncInput): Promise<TreeSyncResult> {
    const writes = input?.write ?? [];
    const deletes = input?.delete ?? [];

    for (const item of writes) {
      const target = resolveTarget(this.base, requirePath("Fs.TreeSync", item?.path));
      if (typeof item?.content !== "string") {
        throw new Error(`Fs.TreeSync: write for '${item?.path}' is missing string 'content'`);
      }
      const buffer = Buffer.from(item.content, item.encoding === "base64" ? "base64" : "utf8");
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, buffer);
      } catch (err) {
        throw wrapFsError("Fs.TreeSync: cannot write", target, err);
      }
    }

    for (const p of deletes) {
      const target = resolveTarget(this.base, requirePath("Fs.TreeSync", p));
      try {
        // force: a path already gone is not an error (idempotent sync);
        // recursive: a deleted path may be a directory.
        await rm(target, { recursive: true, force: true });
      } catch (err) {
        throw wrapFsError("Fs.TreeSync: cannot remove", target, err);
      }
    }

    return { written: writes.length, deleted: deletes.length };
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<TreeSyncResource> {
  return new TreeSyncResource(resolveBase(resource.cwd));
}
