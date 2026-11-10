// Which module manifests had their `metadata.version` moved by one commit, read from
// git alone — whether or not the registry already holds the version. `publish-modules.mjs`
// reports the count so a re-run of a release names the same `modules-<x.y>-<n>` tag.

import { execFileSync } from "node:child_process";

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
 *  `HEAD^` and `HEAD`. Empty when HEAD has no parent. */
export function versionsMovedInHead(cwd, manifests) {
  let changed;
  try {
    changed = new Set(git(cwd, ["diff", "--name-only", "HEAD^", "HEAD"]).split("\n").filter(Boolean));
  } catch {
    console.log("No prior commit to diff against — no version moved in this commit.");
    return new Set();
  }
  const moved = new Set();
  for (const rel of manifests.filter((m) => changed.has(m))) {
    const after = manifestVersionAt(cwd, "HEAD", rel);
    if (after && manifestVersionAt(cwd, "HEAD^", rel) !== after) moved.add(rel);
  }
  return moved;
}
