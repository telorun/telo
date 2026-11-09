/**
 * Which change files (changesets, release fragments) in a tree another ref already
 * carries — read from git history alone.
 *
 * A file of `at`'s tree is CARRIED by `ref` when a file of the same path and the
 * same blob is present at their merge base, or was written on a commit between
 * the merge base and `ref`. It is RELEASED by `ref` when it is carried and `ref`'s
 * own tree no longer holds it — the release consumed it. A file of the same path
 * with other content is neither.
 *
 * It knows no branch or tag names: the caller names the ref. Written in erasable
 * TypeScript importing only `node:` built-ins, so the repository's scripts load
 * this file directly as well as the CLI.
 */

import { execFileSync } from "node:child_process";

export interface CarriedQuery {
  /** Any directory inside the repository; `files` are relative to it. */
  readonly cwd: string;
  readonly files: readonly string[];
  readonly ref: string;
  /** The tree the files are read from. Default `HEAD`. */
  readonly at?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** `path -> blob` of `paths` in `rev`'s tree, paths from the repository root. */
function treeBlobs(top: string, rev: string, paths: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of git(top, ["ls-tree", "-z", "--full-tree", rev, "--", ...paths]).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [, type, blob] = entry.slice(0, tab).split(" ");
    if (type === "blob") blobs.set(entry.slice(tab + 1), blob);
  }
  return blobs;
}

/** `path -> blobs` written to `paths` on the commits of `range`. */
function writtenBlobs(top: string, range: string, paths: readonly string[]): Map<string, Set<string>> {
  const written = new Map<string, Set<string>>();
  const tokens = git(top, ["log", "--raw", "-z", "--no-renames", "--no-abbrev", "--format=", range, "--", ...paths])
    .split("\0")
    .filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!tokens[i].startsWith(":")) continue;
    const meta = tokens[i].split(" ");
    const blob = meta[3];
    const status = meta[4];
    const path = tokens[++i];
    if (status !== "A" && status !== "M") continue;
    const set = written.get(path) ?? new Set<string>();
    set.add(blob);
    written.set(path, set);
  }
  return written;
}

function walk(query: CarriedQuery): { carried: Set<string>; released: Set<string> } {
  const carried = new Set<string>();
  const released = new Set<string>();
  if (query.files.length === 0) return { carried, released };

  const top = git(query.cwd, ["rev-parse", "--show-toplevel"]).trim();
  const prefix = git(query.cwd, ["rev-parse", "--show-prefix"]).trim();
  const byFull = new Map(query.files.map((file) => [prefix + file.split("\\").join("/"), file]));
  const paths = [...byFull.keys()];
  const at = query.at ?? "HEAD";

  let base: string;
  try {
    base = git(top, ["merge-base", at, query.ref]).trim();
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      `${at} and ${query.ref} share no history${detail ? ` (${detail})` : ""}, so which change files ${query.ref} ` +
        `carries cannot be decided. Fetch the full history of both.`,
    );
  }

  const current = treeBlobs(top, at, paths);
  const atBase = treeBlobs(top, base, paths);
  const written = writtenBlobs(top, `${base}..${query.ref}`, paths);
  const atRef = treeBlobs(top, query.ref, paths);
  for (const [path, blob] of current) {
    if (atBase.get(path) !== blob && !written.get(path)?.has(blob)) continue;
    const file = byFull.get(path)!;
    carried.add(file);
    if (!atRef.has(path)) released.add(file);
  }
  return { carried, released };
}

/** The files of `at`'s tree that `ref` carries. */
export function carriedBy(query: CarriedQuery): Set<string> {
  return walk(query).carried;
}

/** The files of `at`'s tree that `ref` carries and no longer holds. */
export function releasedBy(query: CarriedQuery): Set<string> {
  return walk(query).released;
}
