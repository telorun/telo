import { GLOB_PRUNE_DIRS, lastMatchIndex, selectByPatterns } from "@telorun/glob";
import * as fs from "fs";
import * as path from "path";

/** The directory patterns whose whole subtree an `exclude` list rules out: an
 *  exclusion cannot be re-included, so a directory one of them matches holds
 *  nothing discovery could select. Derived only from patterns that name a
 *  directory's entire contents (`<dir>/**`, `<dir>/`); a list carrying a
 *  negation prunes nothing, since its last match decides. */
function excludedDirectoryPatterns(exclude: string[]): string[] {
  const patterns = exclude.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (patterns.some((p) => p.startsWith("!"))) return [];
  const directories: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/**")) {
      // `<dir>/**` is anchored by its inner slash; keep the directory anchored.
      directories.push("/" + pattern.slice(0, -3).replace(/^\//, ""));
    } else if (pattern.endsWith("/")) {
      const directory = pattern.slice(0, -1);
      directories.push(directory.includes("/") ? "/" + directory.replace(/^\//, "") : directory);
    }
  }
  return directories;
}

/** Every file beneath `baseDir`, as POSIX paths relative to it, never entering
 *  a directory the glob engine's hard deny tier or `exclude` discards whole. */
function walkFiles(baseDir: string, exclude: string[]): string[] {
  const excludedDirectories = excludedDirectoryPatterns(exclude);
  const files: string[] = [];
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relDir = pending.pop()!;
    const entries = fs.readdirSync(path.join(baseDir, relDir), { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) {
        files.push(rel);
        continue;
      }
      if (GLOB_PRUNE_DIRS.has(entry.name)) continue;
      if (excludedDirectories.length > 0 && lastMatchIndex(rel, excludedDirectories) >= 0) continue;
      pending.push(rel);
    }
  }
  return files;
}

export function discoverTests(
  baseDir: string,
  include: string[],
  exclude: string[],
  filter?: string,
): string[] {
  const rels = walkFiles(baseDir, exclude);

  // Match with the monorepo's single glob engine. `applyDefaultIgnore: false`
  // skips only the soft tier; the hard tier still denies `node_modules` — the
  // symlinked workspace dupes / vendored copies that must never run as
  // workspace tests — so discovery only adds the user-facing `exclude`
  // (defaults to __fixtures__).
  const selected = selectByPatterns(rels, include, {
    applyDefaultIgnore: false,
    exclude,
  });

  // Dedupe by realpath: the same test file can be reached through a link.
  const seen = new Set<string>();
  const results: string[] = [];
  for (const rel of selected) {
    if (filter && !rel.includes(filter)) continue;
    const abs = path.resolve(baseDir, rel);
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      real = abs;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    results.push(abs);
  }
  results.sort();
  return results;
}
