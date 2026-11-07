#!/usr/bin/env node
// The `version` command of a release branch's Publish workflow.
//
// A branch's FIRST Version PR enters changesets prerelease mode (tag `rc`) before
// versioning, so the PR writes `.changeset/pre.json` and publishes `-rc.N`. Every
// later one just versions: inside prerelease mode changesets keeps counting, after
// `changeset pre exit` it writes the final, and once the final is tagged the branch
// takes patches.
//
// Usage: node scripts/release-version.mjs      (branch from GITHUB_REF_NAME)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, finalPublished } from "./version-line.mjs";

/** Whether the branch has yet to enter candidates: no `pre.json`, and its first
 *  final (`v<major>.<minor>.0`) not yet published. */
export function needsCandidateEntry({ cwd = ROOT, branch }) {
  if (!/^release\/\d+\.\d+$/.test(branch)) throw new Error(`${branch} is not a release/<major>.<minor> branch.`);
  if (existsSync(join(cwd, ".changeset", "pre.json"))) return false;
  return !finalPublished({ cwd, branch });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const branch = process.env.GITHUB_REF_NAME;
    if (!branch) throw new Error("GITHUB_REF_NAME is not set.");
    if (needsCandidateEntry({ branch })) {
      console.log(`release-version: ${branch} has no candidates and no final yet — entering prerelease mode (rc).`);
      run("pnpm", ["exec", "changeset", "pre", "enter", "rc"]);
    }
    run("pnpm", ["run", "version-packages"]);
  } catch (error) {
    console.error(`::error::release-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
