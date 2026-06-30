import type { ResourceInstance } from "@telorun/sdk";
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
  constructor(private readonly base: string) {}

  async invoke(input: FileRemovalInput): Promise<FileRemovalResult> {
    const target = resolveTarget(this.base, requirePath("Fs.FileRemoval", input?.path));
    try {
      // force:false so a missing path is surfaced (ENOENT), not swallowed.
      await rm(target, { recursive: Boolean(input?.recursive), force: false });
      return { removed: true };
    } catch (err) {
      throw wrapFsError("Fs.FileRemoval: cannot remove", target, err);
    }
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<FileRemovalResource> {
  return new FileRemovalResource(resolveBase(resource.cwd));
}
