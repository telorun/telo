import { selectByPatterns } from "@telorun/glob";
import * as fs from "fs";
import * as path from "path";

/**
 * Select files under `manifestDir` matching the ordered, `.gitignore`-style
 * allowlist `patterns`. The match itself runs through the monorepo's single
 * glob engine (`selectByPatterns` in `@telorun/glob`) — this function owns
 * only the Node `fs` walk and the symlink-confinement guard. Returns
 * manifest-relative POSIX paths, sorted for determinism.
 *
 * `applyDefaultIgnore: false` opts out of the soft default-ignore tier (used by
 * `include:` resolution, which may reach any co-located partial); the hard tier
 * (`node_modules`/`.git`/`.telo`) is always denied regardless.
 *
 * Throws if a selected file resolves (via a symlink) outside `manifestDir`.
 */
export function selectFiles(
  manifestDir: string,
  patterns: string[],
  opts: { applyDefaultIgnore?: boolean } = {},
): string[] {
  if (patterns.length === 0) return [];

  // The recursive readdir still enumerates `node_modules/` etc. before the deny
  // pass filters them — publish is not a hot path, so the full walk is fine.
  const entries = fs.readdirSync(manifestDir, { recursive: true, withFileTypes: true });
  const rels: string[] = [];
  for (const entry of entries) {
    // Non-files (incl. symlinks) are skipped here, so a symlink never enters
    // the bundle regardless of what a pattern matches.
    if (!entry.isFile()) continue;
    rels.push(path.relative(manifestDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
  }

  const selected = selectByPatterns(rels, patterns, {
    applyDefaultIgnore: opts.applyDefaultIgnore,
  });

  const realManifestDir = fs.realpathSync(manifestDir) + path.sep;
  for (const rel of selected) {
    const real = fs.realpathSync(path.resolve(manifestDir, rel));
    if (!real.startsWith(realManifestDir)) {
      throw new Error(
        `files pattern selected '${rel}', which resolves outside the module directory. ` +
          `Bundling files from outside the module root is not allowed.`,
      );
    }
  }

  return selected;
}
