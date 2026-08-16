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

  assertWithinModule(manifestDir, selected);
  return selected;
}

/**
 * Reject any payload path that does not exist, or that resolves — via a symlink
 * — outside `manifestDir`.
 *
 * Separate from {@link selectFiles} because a `files:` pattern is no longer the
 * only route into the payload: a bundled controller's `path=` entry joins it
 * from `controllers:`, and the guard has to cover what actually ships rather
 * than what a pattern happened to match. Applied to the whole partition, so
 * every file in every layer passes it.
 *
 * A missing file is reported here because publish is about to read it, and
 * "declared but absent" is the same class of mistake as "declared but outside" —
 * both fail only on a consumer's machine if they get through. Missing paths are
 * **aggregated**, since a manifest that names three files it does not have
 * should say so once rather than three times.
 *
 * `supplied` names paths whose CONTENT the caller already holds in memory
 * rather than on disk. That is not a loophole but the normal case now: a bundled
 * controller's `path=` entry point is a gitignored build artifact, built from
 * its source by the kernel during this very publish, so on a fresh clone it does
 * not exist and must not — demanding it back was demanding a build step this
 * design removed. Confinement still applies to it through the source it was
 * built from.
 */
export function assertWithinModule(
  manifestDir: string,
  rels: Iterable<string>,
  supplied: ReadonlySet<string> = new Set(),
): void {
  const realManifestDir = fs.realpathSync(manifestDir) + path.sep;
  const missing: string[] = [];
  for (const rel of rels) {
    if (supplied.has(rel)) continue;
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(manifestDir, rel));
    } catch {
      missing.push(rel);
      continue;
    }
    if (!real.startsWith(realManifestDir)) {
      throw new Error(
        `'${rel}' resolves outside the module directory. ` +
          `Bundling files from outside the module root is not allowed.`,
      );
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Manifest names ${missing.length} file(s) that do not exist: ${missing.join(", ")}. ` +
        `Paths are relative to the module root — the directory holding telo.yaml.`,
    );
  }
}
