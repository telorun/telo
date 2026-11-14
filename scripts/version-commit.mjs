// The version commit a Publish run releases: the tip when it moved the versions, else
// the newest `chore(release): version` commit beneath it. A fix pushed onto a release
// branch after its release PR merged — a pipeline repair, for one — leaves the version
// commit behind the tip, and a run that read only `HEAD^..HEAD` would see no release.
//
// A record commit (`chore(release): record <tag> on main`, squashed onto main) never
// counts, at the tip or beneath it: it moves versions to ones already released, and a
// branch cut at it must not release them.

import { execFileSync } from "node:child_process";

const VERSION_SUBJECT = /^chore\(release\): version\b/;
const RECORD_SUBJECT = /^chore\(release\): record\b/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Whether `commit` is main's record of a release. */
export function isRecordCommit({ cwd, commit }) {
  return RECORD_SUBJECT.test(git(cwd, "log", "-1", "--format=%s", commit));
}

/**
 * The newest commit on HEAD's first-parent line that `moves(sha)` — HEAD itself when it
 * does and is no record commit, else the newest `chore(release): version` commit touching
 * `paths` that does — or undefined. `moves` asks whether a commit moved the versions
 * against its parent.
 */
export function newestVersionCommit({ cwd, paths, moves }) {
  const head = git(cwd, "rev-parse", "HEAD");
  if (!isRecordCommit({ cwd, commit: head }) && moves(head)) return head;
  const log = git(cwd, "log", "--first-parent", "--format=%H%x09%s", "--", ...paths);
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\t");
    if (sha !== head && VERSION_SUBJECT.test(subject ?? "") && moves(sha)) return sha;
  }
  return undefined;
}
