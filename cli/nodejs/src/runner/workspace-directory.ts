import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  WorkspaceAccess,
  WorkspaceChangeSet,
  WorkspaceCheckpointFile,
  WorkspaceTree,
} from "@telorun/runner-core";
import { normalizeBundlePath, WORKSPACE_EXCLUDED_DIRECTORIES } from "@telorun/runner-core";

/**
 * The workspace surface of a local session: a plain directory.
 *
 * The container backends reach their workspace through a service running in the
 * session (`Http.Api` over the `fs` module) because nothing else can write a
 * volume they do not mount. A local runner holds the directory itself, so the
 * same four operations are filesystem calls — no second process, no port, no
 * readiness wait.
 *
 * What it must match exactly is the SHAPE those four return, because the editor
 * diffs its own files against them: a content hash per file (sha256 hex), paths
 * relative to the root with `/` separators, and the same skipped directories —
 * a tree that disagrees with the other backends' would show every file as
 * changed on the first sync.
 */

/** The one list every backend skips, from the package that owns the contract —
 *  a second copy here is what would make this tree disagree with the container
 *  backends' and show every file as changed on the first sync. */
const EXCLUDED = new Set(WORKSPACE_EXCLUDED_DIRECTORIES);

export class WorkspaceDirectory implements WorkspaceAccess {
  constructor(private readonly root: string) {}

  async tree(): Promise<WorkspaceTree> {
    const files = await this.walk();
    return {
      files: await Promise.all(
        files.map(async (relative) => ({
          path: relative,
          hash: createHash("sha256").update(await fs.readFile(this.resolve(relative))).digest("hex"),
        })),
      ),
    };
  }

  async readFile(relative: string): Promise<{ content: string; size: number }> {
    const bytes = await fs.readFile(this.resolve(relative));
    return { content: bytes.toString("utf8"), size: bytes.byteLength };
  }

  async apply(changes: WorkspaceChangeSet): Promise<{ written: number; deleted: number }> {
    let written = 0;
    for (const entry of changes.write ?? []) {
      const target = this.resolve(entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(
        target,
        Buffer.from(entry.content, entry.encoding === "base64" ? "base64" : "utf8"),
      );
      written += 1;
    }
    let deleted = 0;
    for (const relative of changes.delete ?? []) {
      // A path that is already gone is the state the caller asked for; only a
      // real failure is reported.
      try {
        await fs.rm(this.resolve(relative), { force: true });
        deleted += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return { written, deleted };
  }

  async snapshot(): Promise<WorkspaceCheckpointFile[]> {
    const files = await this.walk();
    return Promise.all(
      files.map(async (relative) => {
        const bytes = await fs.readFile(this.resolve(relative));
        return {
          path: relative,
          hash: createHash("sha256").update(bytes).digest("hex"),
          // Always base64, as the workspace application's snapshot is: a
          // checkpoint has to round-trip a workspace exactly, and deciding text
          // versus binary per file is a guess that corrupts whichever file it
          // gets wrong.
          content: bytes.toString("base64"),
          encoding: "base64" as const,
        };
      }),
    );
  }

  /** Re-run one app with no file change: rewrite its entry manifest with the
   *  bytes it already holds, so the kernel's watcher fires exactly as it does
   *  for an edit. The same trick the container backends use, for the same
   *  reason — nothing has to signal into the workload. */
  async touch(relative: string): Promise<void> {
    const target = this.resolve(relative);
    await fs.writeFile(target, await fs.readFile(target));
  }

  /** Resolve a client path against the root. Core normalizes every inbound path
   *  already; this is the second half of that guard, where the root is known. */
  private resolve(relative: string): string {
    const normalized = normalizeBundlePath(relative);
    return path.join(this.root, normalized);
  }

  private async walk(): Promise<string[]> {
    const found: string[] = [];
    const visit = async (dir: string, prefix: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const entry of entries) {
        if (EXCLUDED.has(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await visit(path.join(dir, entry.name), relative);
        } else if (entry.isFile()) {
          found.push(relative);
        }
      }
    };
    await visit(this.root, "");
    return found.sort();
  }
}
