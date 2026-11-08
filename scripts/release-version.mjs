#!/usr/bin/env node
// The `version` command of a release branch's Publish workflow, and of Finish
// release.
//
// A branch's FIRST Version PR enters changesets prerelease mode (tag `rc`) before
// versioning, so the PR writes `.changeset/pre.json` and publishes `-rc.N`. Later
// ones keep counting candidates. Prerelease mode ends only inside the final Version
// PR: Finish release builds it with `--final` (exit, then version), and the open
// PR's head having no `.changeset/pre.json` records that the branch is going final,
// so every later rebuild of it exits again. Closing that PR goes back to candidates.
// After the final is tagged the branch takes patches.
//
// Usage: node scripts/release-version.mjs [--final]   (branch from GITHUB_REF_NAME)

import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/** The Version PR branch of a release branch: where Publish and Finish push it. */
export function versionPrBranch(branch) {
  return `changeset-release/${branch}`;
}

/** Whether the Version PR branch, as last fetched, lacks `.changeset/pre.json`. */
export function versionPrHeadLacksPre({ cwd = ROOT, branch }) {
  const ref = `refs/remotes/origin/${versionPrBranch(branch)}`;
  execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, stdio: "ignore" });
  const listed = execFileSync("git", ["ls-tree", "--name-only", ref, ".changeset/pre.json"], { cwd, encoding: "utf8" });
  return listed.trim() === "";
}

/**
 * What the version step does to prerelease mode before `changeset version`:
 * `enter` (the branch's first Version PR), `exit` (the final Version PR) or `none`.
 * `openPr` is whether a Version PR is open; `headLacksPre` is read only then.
 */
export function prereleaseAction({ cwd = ROOT, branch, final = false, openPr = false, headLacksPre = () => false }) {
  if (needsCandidateEntry({ cwd, branch })) return "enter";
  const file = join(cwd, ".changeset", "pre.json");
  if (!existsSync(file) || JSON.parse(readFileSync(file, "utf8")).mode !== "pre") return "none";
  return final || (openPr && headLacksPre()) ? "exit" : "none";
}

function openVersionPr(branch) {
  const head = versionPrBranch(branch);
  const out = execFileSync("gh", ["pr", "list", "--head", head, "--base", branch, "--state", "open", "--json", "number"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (JSON.parse(out).length === 0) return false;
  execFileSync("git", ["fetch", "--quiet", "origin", `+refs/heads/${head}:refs/remotes/origin/${head}`], { cwd: ROOT, stdio: "inherit" });
  return true;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const branch = process.env.GITHUB_REF_NAME;
    if (!branch) throw new Error("GITHUB_REF_NAME is not set.");
    const final = process.argv.includes("--final");
    const action = prereleaseAction({
      branch,
      final,
      openPr: !final && openVersionPr(branch),
      headLacksPre: () => versionPrHeadLacksPre({ branch }),
    });
    if (action === "enter") {
      console.log(`release-version: ${branch} has no candidates and no final yet — entering prerelease mode (rc).`);
      run("pnpm", ["exec", "changeset", "pre", "enter", "rc"]);
    } else if (action === "exit") {
      console.log(`release-version: ${branch} is going final — leaving prerelease mode.`);
      run("pnpm", ["exec", "changeset", "pre", "exit"]);
    }
    run("pnpm", ["run", "version-packages"]);
  } catch (error) {
    console.error(`::error::release-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
