// Dependency ordering for module manifest pushes, shared by the release publish
// (`publish-modules.mjs`, the changed set) and the OCI backfill
// (`publish-oci-backfill.mjs`, the whole tree).
//
// Both need the same guarantee: `telo publish` canonicalizes a relative
// `imports:` source against the destination and then HARD-FAILS if the derived
// ref does not already resolve there, so a sibling must be pushed before its
// dependents. Ordering is the only thing that makes a multi-module push succeed.
//
// The answer now comes from the release model (`telo release order`), which
// reads the import graph through the real manifest transform. This file used to
// carry a regex that matched `imports:` in the first YAML document by line
// shape — it could not see an object-form entry, a folded source, or an import
// declared anywhere the layout did not anticipate, and a miss here is a failed
// push rather than a wrong sort.

import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A manifest path as the release model keys it: workspace-relative, POSIX. The
 *  key IS `relative(root, dir)` — reconstructing it from two path segments
 *  worked only for `<area>/<name>` and dropped anything deeper into the
 *  unknown-module tail, where a miss is a failed push rather than a wrong sort. */
function moduleKeyOf(manifestPath) {
  return relative(ROOT, dirname(resolve(manifestPath))).split(sep).join("/");
}

/**
 * `paths` (absolute module manifest paths) sorted so a dependency precedes its
 * dependents, each with the destination it publishes to.
 *
 * **The destination travels with the order**, because a workspace may declare a
 * registry base per subtree and deriving one here — `$TELO_OCI_REGISTRY` plus the
 * directory name — would plan several bases and push them all to one, silently.
 * That was the last fact this script still derived for itself.
 *
 * Modules the release model does not know about keep their incoming order at the
 * end with no destination, so a manifest outside the workspace is still visible
 * rather than dropped; the caller decides what to do with one it cannot address.
 */
export function orderByDependencies(paths) {
  const byKey = new Map(paths.map((p) => [moduleKeyOf(p), p]));
  const ordered = JSON.parse(
    execFileSync("node", ["./cli/nodejs/bin/telo.mjs", "release", "order", "-o", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ).order;

  const sorted = [];
  for (const entry of ordered) {
    const path = byKey.get(entry.key);
    if (path) {
      sorted.push({ path, destination: entry.destination });
      byKey.delete(entry.key);
    }
  }
  return [...sorted, ...[...byKey.values()].map((path) => ({ path, destination: undefined }))];
}

/**
 * Every module's publish destination, keyed by absolute manifest path.
 *
 * The presence gate ("is this version already published?") has to ask the SAME
 * registry the push will use. Deriving it from the ambient base was the last
 * place this script answered a destination question for itself: in a workspace
 * that publishes its subtrees to different bases it would query the wrong
 * repository, and a same-named repo under the ambient base carrying that version
 * would read as already published — so the module would never be pushed, with no
 * error anywhere.
 */
export function destinationsByManifest() {
  const ordered = JSON.parse(
    execFileSync("node", ["./cli/nodejs/bin/telo.mjs", "release", "order", "-o", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ).order;
  return new Map(ordered.map((entry) => [manifestPathFor(entry.key), entry.destination]));
}

/** Absolute manifest path for a workspace-relative module key. */
export function manifestPathFor(key) {
  return join(ROOT, key, "telo.yaml");
}
