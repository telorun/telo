/**
 * The files changed since a base ref, less those a release tag already carries.
 *
 * A commit contained in a `v*`, `modules-*` or `packages-*` tag is released. On a release
 * branch's merge-back, the tag brings in commits (and their changed files) that
 * need no changelog entry of their own, so they are not counted. With no such
 * tag in range this is the plain `base...HEAD` name list.
 */

import { execFileSync } from "node:child_process";

const RELEASE_TAGS = ["--tags=v*", "--tags=modules-*", "--tags=packages-*"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function lines(output: string): string[] {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Throws when git cannot answer (no merge base, a shallow clone). */
export function changedFilesSinceBase(cwd: string, baseRef: string): string[] {
  const range = `${baseRef}..HEAD`;
  const all = lines(git(cwd, ["rev-list", range]));
  const unreleased = lines(git(cwd, ["rev-list", range, "--not", ...RELEASE_TAGS]));
  if (unreleased.length === all.length) {
    return lines(git(cwd, ["diff", "--name-only", `${baseRef}...HEAD`]));
  }
  const files = git(cwd, ["log", "--format=", "--name-only", "--no-merges", range, "--not", ...RELEASE_TAGS]);
  return [...new Set(lines(files))];
}
