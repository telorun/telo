import type { ModuleSource, SourceEntry } from "@telorun/analyzer";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

/** What is on disk at a staged path, measured against the `sources:` entry that
 *  stages it. */
export type StagedEntryState =
  | { readonly state: "match" }
  | { readonly state: "unpinned" }
  | { readonly state: "missing"; readonly detail: string }
  | { readonly state: "mismatch"; readonly detail: string };

/**
 * Check a staged entry against its declaration: a file's bytes and execute bit
 * against its pin, a link's stored target against `target`. A link is followed
 * through the entries of its own source, so it matches only when the file at the
 * end of the chain does.
 *
 * The one rule `telo release stage`, publish and a kernel reading a source
 * checkout all apply, so a file one of them accepts none of the others refuses.
 */
export async function checkStagedEntry(
  dir: string,
  source: ModuleSource,
  entry: SourceEntry,
): Promise<StagedEntryState> {
  const visited = new Set<string>();
  let current = entry;
  for (;;) {
    const via = current === entry ? "" : `through the link to '${current.path}', `;
    visited.add(current.path);
    const abs = path.resolve(dir, current.path);
    const stat = await fs.lstat(abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return undefined;
      throw err;
    });
    if (current.kind === "link") {
      const link = current;
      if (!stat) return { state: "missing", detail: `${via}'${link.path}' is not on disk` };
      const stored = stat.isSymbolicLink() ? await fs.readlink(abs) : undefined;
      if (stored === undefined || stored.replace(/\\/g, "/") !== link.target) {
        return {
          state: "mismatch",
          detail: `${via}'${link.path}' is not a symbolic link to '${link.target}'`,
        };
      }
      const next = source.entries.find((candidate) => candidate.path === link.resolved);
      if (!next || visited.has(next.path)) {
        return {
          state: "mismatch",
          detail: `${via}the link '${link.path}' does not lead to a file entry of source '${source.name}'`,
        };
      }
      current = next;
      continue;
    }
    if (!current.pin) return { state: "unpinned" };
    if (!stat) return { state: "missing", detail: `${via}'${current.path}' is not on disk` };
    if (!stat.isFile()) {
      return { state: "mismatch", detail: `${via}'${current.path}' is not a regular file` };
    }
    const executable = (stat.mode & 0o111) !== 0;
    // Windows has no execute bit, so every file reads as not executable there;
    // the bytes are what can be verified.
    if (process.platform !== "win32" && executable !== current.pin.executable) {
      return {
        state: "mismatch",
        detail:
          `${via}'${current.path}' is ${executable ? "" : "not "}executable, but the pin says ` +
          `executable: ${current.pin.executable}`,
      };
    }
    const digest = createHash("sha256").update(await fs.readFile(abs)).digest("hex");
    if (digest !== current.pin.sha256) {
      return {
        state: "mismatch",
        detail: `${via}'${current.path}' hashes to sha256 ${digest}, but the pin is ${current.pin.sha256}`,
      };
    }
    return { state: "match" };
  }
}
