import type { ResourceInstance } from "@telorun/sdk";
import { mkdir } from "node:fs/promises";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface DirectoryCreationInput {
  path: string;
  createParents?: boolean;
}

interface DirectoryCreationResult {
  created: boolean;
}

class DirectoryCreationResource implements ResourceInstance<DirectoryCreationInput, DirectoryCreationResult> {
  constructor(private readonly base: string) {}

  async invoke(input: DirectoryCreationInput): Promise<DirectoryCreationResult> {
    const target = resolveTarget(this.base, requirePath("Fs.DirectoryCreation", input?.path));
    try {
      if (input?.createParents) {
        // Recursive mkdir returns the first created path, or undefined when the
        // directory already existed — that's the created/no-op signal.
        const first = await mkdir(target, { recursive: true });
        return { created: first !== undefined };
      }
      await mkdir(target);
      return { created: true };
    } catch (err) {
      throw wrapFsError("Fs.DirectoryCreation: cannot create", target, err);
    }
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<DirectoryCreationResource> {
  return new DirectoryCreationResource(resolveBase(resource.cwd));
}
