import type { ResourceInstance } from "@telorun/sdk";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { FsManifest, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";

interface DirectoryListingInput {
  path?: string;
  recursive?: boolean;
}

interface Entry {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  size: number;
}

interface DirectoryListingResult {
  entries: Entry[];
}

function classify(stats: { isFile(): boolean; isDirectory(): boolean }): Entry["type"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

class DirectoryListingResource implements ResourceInstance<DirectoryListingInput, DirectoryListingResult> {
  constructor(private readonly base: string) {}

  async invoke(input: DirectoryListingInput): Promise<DirectoryListingResult> {
    const root = input?.path ? resolveTarget(this.base, input.path) : this.base;
    const entries: Entry[] = [];
    await this.walk(root, Boolean(input?.recursive), entries);
    return { entries };
  }

  private async walk(dir: string, recursive: boolean, out: Entry[]): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      throw wrapFsError("Fs.DirectoryListing: cannot list", dir, err);
    }
    names.sort();
    for (const name of names) {
      const full = path.join(dir, name);
      // lstat (not stat) so a broken or out-of-tree symlink is reported as
      // "other" rather than throwing. Wrapped so a mid-walk race (entry removed
      // after readdir) or permission error names the path like every other op.
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(full);
      } catch (err) {
        throw wrapFsError("Fs.DirectoryListing: cannot stat", full, err);
      }
      const type = classify(stats);
      out.push({ name, path: path.relative(this.base, full), type, size: stats.size });
      if (recursive && type === "directory") await this.walk(full, recursive, out);
    }
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<DirectoryListingResource> {
  return new DirectoryListingResource(resolveBase(resource.cwd));
}
