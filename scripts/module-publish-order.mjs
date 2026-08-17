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
 * dependents. Modules the release model does not know about keep their incoming
 * order at the end, so a manifest outside the workspace is still pushed rather
 * than dropped.
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
  for (const key of ordered) {
    const path = byKey.get(key);
    if (path) {
      sorted.push(path);
      byKey.delete(key);
    }
  }
  return [...sorted, ...byKey.values()];
}

/** Absolute manifest path for a workspace-relative module key. */
export function manifestPathFor(key) {
  return join(ROOT, key, "telo.yaml");
}
