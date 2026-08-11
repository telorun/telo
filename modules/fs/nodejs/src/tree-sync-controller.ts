import { SEVERITY, type Logger, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FsManifest,
  requirePath,
  resolveBase,
  resolveTarget,
  toWritableBytes,
  WritableContent,
  wrapFsError,
} from "./fs-support.js";

interface WriteItem {
  path: string;
  content: WritableContent;
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
  constructor(
    private readonly base: string,
    private readonly log: Logger,
  ) {}

  async invoke(input: TreeSyncInput): Promise<TreeSyncResult> {
    const writes = input?.write ?? [];
    const deletes = input?.delete ?? [];

    for (const item of writes) {
      const target = resolveTarget(this.base, requirePath("Fs.TreeSync", item?.path));
      const buffer = toWritableBytes(
        `Fs.TreeSync: write for '${item?.path}'`,
        item?.content,
        item?.encoding,
      );
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, buffer);
        if (this.log.enabled(SEVERITY.debug)) {
          this.log.debug("Wrote", { "file.path": target, "file.size": buffer.byteLength });
        }
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
        // Per path at `debug`; the default-visible account is the single summary
        // below. A sync legitimately carries hundreds of paths, so one `info`
        // each would make a routine delta the loudest thing in the log.
        if (this.log.enabled(SEVERITY.debug)) {
          this.log.debug("Deleted", { "file.path": target });
        }
      } catch (err) {
        throw wrapFsError("Fs.TreeSync: cannot remove", target, err);
      }
    }

    // `info`, once: this delete is recursive and `force: true`, so a mistyped
    // path takes a tree and a path that never existed reports success either
    // way. The count is the account that a deletion happened at all; `debug`
    // above says which paths.
    if (deletes.length > 0) {
      this.log.info("Deleted paths", { "fs.deleted_count": deletes.length });
    }

    return { written: writes.length, deleted: deletes.length };
  }
}

export function register(): void {}

export async function create(
  resource: FsManifest,
  ctx: ResourceContext,
): Promise<TreeSyncResource> {
  return new TreeSyncResource(resolveBase(resource.cwd), ctx.log);
}
