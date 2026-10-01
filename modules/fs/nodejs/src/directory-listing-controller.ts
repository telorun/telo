import type { ResourceInstance } from "@telorun/sdk";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  FsManifest,
  resolveBase,
  resolveTarget,
  toManifestPath,
  wrapFsError,
} from "./fs-support.js";
import { comparePaths } from "./path-order.js";

interface DirectoryListingInput {
  path?: string;
  recursive?: boolean;
  exclude?: string[];
  /** A computed limit arrives as an int64. */
  limit?: number | bigint;
  cursor?: string;
}

interface Entry {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  size: number;
}

interface DirectoryListingResult {
  entries: Entry[];
  nextCursor?: string;
}

function classify(stats: { isFile(): boolean; isDirectory(): boolean }): Entry["type"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

/** One thing a directory contributes to its listing: a child's own entry, or
 *  everything beneath a child directory. `key` is where it sorts. */
interface Slot {
  key: string;
  name: string;
  beneath: boolean;
}

class DirectoryListingResource implements ResourceInstance<DirectoryListingInput, DirectoryListingResult> {
  constructor(private readonly base: string) {}

  async invoke(input: DirectoryListingInput): Promise<DirectoryListingResult> {
    const root = input?.path ? resolveTarget(this.base, input.path) : this.base;
    const exclude = new Set(input?.exclude ?? []);
    const limit = input?.limit === undefined ? undefined : Number(input.limit);
    const entries: Entry[] = [];
    // The walk yields in path order, so a page is its next `limit` entries; one
    // more says whether a page follows, and nothing past it is read.
    for await (const entry of this.walk(root, Boolean(input?.recursive), exclude, input?.cursor)) {
      if (entries.length === limit) {
        return { entries, nextCursor: entries[entries.length - 1]!.path };
      }
      entries.push(entry);
    }
    return { entries };
  }

  /** The entries at and beneath `dir` that follow `cursor`, in path order. A
   *  child's entry sorts at its path and its subtree at that path plus `/`, so
   *  ordering one directory's slots orders the whole listing with no global sort. */
  private async *walk(
    dir: string,
    recursive: boolean,
    exclude: Set<string>,
    cursor: string | undefined,
  ): AsyncGenerator<Entry> {
    let children: Dirent[];
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw wrapFsError("Fs.DirectoryListing: cannot list", dir, err);
    }
    const prefix = toManifestPath(this.base, dir);
    const slots: Slot[] = [];
    for (const child of children) {
      if (exclude.has(child.name)) continue;
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (cursor === undefined || comparePaths(relative, cursor) > 0) {
        slots.push({ key: relative, name: child.name, beneath: false });
      }
      if (!recursive || !child.isDirectory()) continue;
      // Once the cursor is past everything under `<path>/`, an earlier page
      // already returned it and the directory is not listed again.
      const beneath = `${relative}/`;
      const alreadyReturned =
        cursor !== undefined && comparePaths(cursor, beneath) > 0 && !cursor.startsWith(beneath);
      if (!alreadyReturned) slots.push({ key: beneath, name: child.name, beneath: true });
    }
    slots.sort((a, b) => comparePaths(a.key, b.key));

    for (const slot of slots) {
      const full = path.join(dir, slot.name);
      if (slot.beneath) {
        yield* this.walk(full, recursive, exclude, cursor);
        continue;
      }
      // lstat (not stat) so a broken or out-of-tree symlink is reported as
      // "other" rather than throwing. Wrapped so a mid-walk race (entry removed
      // after readdir) or permission error names the path like every other op.
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(full);
      } catch (err) {
        throw wrapFsError("Fs.DirectoryListing: cannot stat", full, err);
      }
      yield { name: slot.name, path: slot.key, type: classify(stats), size: stats.size };
    }
  }
}

export function register(): void {}

export async function create(resource: FsManifest): Promise<DirectoryListingResource> {
  return new DirectoryListingResource(resolveBase(resource.cwd));
}
