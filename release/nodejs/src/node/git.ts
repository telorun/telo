/** The git reads a release takes: the files changed since a base, a file as a
 *  commit holds it, and the release tags. */

import { execFileSync } from "node:child_process";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The files changed since a base ref: the plain `base...HEAD` name list.
 *  Throws when git cannot answer (no merge base, a shallow clone). */
export function changedFilesSinceBase(cwd: string, baseRef: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** `path` (relative to `cwd`) as `rev` holds it, or `undefined` when it holds
 *  none. Any other failure throws. */
export function fileAt(cwd: string, rev: string, path: string): string | undefined {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  } catch {
    return undefined;
  }
  const prefix = git(cwd, ["rev-parse", "--show-prefix"]).trim();
  const listed = git(cwd, ["ls-tree", "--name-only", "--full-tree", rev, "--", prefix + path]).trim();
  if (listed === "") return undefined;
  return git(cwd, ["show", `${rev}:${prefix + path}`]);
}

/** The commit a tag points at, or `undefined` when the tag does not exist. */
export function tagCommit(cwd: string, tag: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function headCommit(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

export function createTag(cwd: string, tag: string): void {
  git(cwd, ["tag", tag, "HEAD"]);
}
