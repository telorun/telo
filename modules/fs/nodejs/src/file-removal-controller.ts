import type { Logger, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { rm } from "node:fs/promises";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface FileRemovalInput {
  path: string;
  recursive?: boolean;
}

interface FileRemovalResult {
  removed: boolean;
}

class FileRemovalResource implements ResourceInstance<FileRemovalInput, FileRemovalResult> {
  constructor(
    private readonly base: string,
    private readonly log: Logger,
  ) {}

  async invoke(input: FileRemovalInput): Promise<FileRemovalResult> {
    const target = resolveTarget(this.base, requirePath("Fs.FileRemoval", input?.path));
    try {
      // force:false so a missing path is surfaced (ENOENT), not swallowed.
      await rm(target, { recursive: Boolean(input?.recursive), force: false });
      // `info`, unlike a write: a deletion is the one filesystem operation with
      // nothing left behind to inspect afterwards, and a recursive one can take
      // a whole tree. What was removed is only knowable if it was recorded.
      this.log.info("Removed", {
        "file.path": target,
        "fs.recursive": Boolean(input?.recursive),
      });
      return { removed: true };
    } catch (err) {
      throw wrapFsError("Fs.FileRemoval: cannot remove", target, err);
    }
  }
}

export function register(): void {}

export async function create(
  resource: FsManifest,
  ctx: ResourceContext,
): Promise<FileRemovalResource> {
  return new FileRemovalResource(resolveBase(resource.cwd), ctx.log);
}
