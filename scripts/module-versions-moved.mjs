// Which module manifests had their `metadata.version` moved by one commit, read from
// git alone — whether or not the registry already holds the version. `publish-modules.mjs`
// reports the count so a re-run of a release names the same `modules-<x.y>-<n>` tag.

import { execFileSync } from "node:child_process";
import { tagsOfReleaseCommit } from "./release-commit.mjs";
import { newestVersionCommit } from "./version-commit.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** metadata.version of the first YAML document of `path` at `ref`, scoped to the `metadata:`
 *  block so a nested `version` field can't match. Null when the file is absent at that ref or
 *  declares none. */
export function manifestVersionAt(cwd, ref, path) {
  let content;
  try {
    content = git(cwd, ["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
  const docEnd = content.search(/^---\s*$/m);
  const firstDoc = docEnd === -1 ? content : content.slice(0, docEnd);
  const metaMatch = firstDoc.match(/^metadata:\s*\n((?:[ \t]+.*\n?)+)/m);
  if (!metaMatch) return null;
  const versionMatch = metaMatch[1].match(/^[ \t]+version:[ \t]*["']?(\d+\.\d+\.\d+)["']?[ \t]*$/m);
  return versionMatch ? versionMatch[1] : null;
}

/** The members of `manifests` (paths relative to `cwd`) whose version differs between
 *  `sha^` and `sha`. Empty when `sha` has no parent. */
export function versionsMovedIn(cwd, sha, manifests) {
  let changed;
  try {
    changed = new Set(git(cwd, ["diff", "--name-only", `${sha}^`, sha]).split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
  const moved = new Set();
  for (const rel of manifests.filter((m) => changed.has(m))) {
    const after = manifestVersionAt(cwd, sha, rel);
    if (after && manifestVersionAt(cwd, `${sha}^`, rel) !== after) moved.add(rel);
  }
  return moved;
}

/**
 * The members of `manifests` whose version the run's release moved: those of the tip,
 * else those of the newest version commit beneath it (`version-commit.mjs`) — unless a
 * `modules-*` tag already contains it, which makes a later tip no release of its own.
 * A tag naming the tip as its release commit is the tip's own, so a re-run re-derives it.
 */
export function versionsMovedInRelease(cwd, manifests) {
  const commit = newestVersionCommit({
    cwd,
    paths: manifests,
    moves: (sha) => versionsMovedIn(cwd, sha, manifests).size > 0,
  });
  if (!commit) {
    console.log("No version moved in the release commit — nothing to number.");
    return new Set();
  }
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const tagged = git(cwd, ["tag", "--contains", commit, "--list", "modules-*"]) !== "";
  if (commit !== head && tagged && tagsOfReleaseCommit({ cwd, commit: head, patterns: ["refs/tags/modules-*"] }).length === 0) {
    return new Set();
  }
  return versionsMovedIn(cwd, commit, manifests);
}
