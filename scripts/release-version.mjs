#!/usr/bin/env node
// Whether a release branch's next release PR versions its units as CANDIDATES.
//
// Candidacy is derived, never stored: a branch `release/<x.y>` is in candidates
// while `v<x.y>.0` does not exist and its open release PR's head carries no final
// versions. Publish final release builds the final PR (`--final`), and the head it
// pushes records final versions in `.changes/ledger.yaml`, so every later rebuild
// of that open PR is the final too; closing it goes back to candidates. A branch
// that has published `v<x.y>.0` takes patches, which are finals.
//
// Usage: node scripts/release-version.mjs [--final] [--branch <release/x.y>]
//        (the branch defaults to GITHUB_REF_NAME; writes `candidate` as a step output)

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { ledgerVersionsAt } from "./release-units.mjs";
import { ROOT, finalPublished } from "./version-line.mjs";

const RELEASE_BRANCH = /^release\/\d+\.\d+$/;

/** The release PR branch of a release branch: where Publish and Finish push it. */
export function versionPrBranch(branch) {
  return `release-version/${branch}`;
}

/** Whether the release PR's head, as last fetched, records a final version its base
 *  does not: a unit's ledger `version` moved, which only a final apply writes. */
export function headCarriesFinal({ cwd = ROOT, branch }) {
  const head = `refs/remotes/origin/${versionPrBranch(branch)}`;
  const base = execFileSync("git", ["merge-base", head, `refs/remotes/origin/${branch}`], { cwd, encoding: "utf8" }).trim();
  const before = ledgerVersionsAt(cwd, base);
  for (const [key, entry] of ledgerVersionsAt(cwd, head)) {
    if (entry.version !== undefined && entry.version !== before.get(key)?.version) return true;
  }
  return false;
}

/**
 * Whether the release PR built now versions candidates. `openPr` is whether a
 * release PR is open; `carriesFinal` is asked only then.
 */
export function isCandidate({ cwd = ROOT, branch, final = false, openPr = false, carriesFinal = () => false }) {
  if (!RELEASE_BRANCH.test(branch ?? "")) throw new Error(`${branch} is not a release/<major>.<minor> branch.`);
  if (final || finalPublished({ cwd, branch })) return false;
  return !(openPr && carriesFinal());
}

/** Whether a release PR is open for `branch`, fetching its head when it is. */
function openReleasePr(branch) {
  const head = versionPrBranch(branch);
  const out = execFileSync("gh", ["pr", "list", "--head", head, "--base", branch, "--state", "open", "--json", "number"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (JSON.parse(out).length === 0) return false;
  execFileSync("git", ["fetch", "--quiet", "origin", `+refs/heads/${head}:refs/remotes/origin/${head}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: ROOT,
    stdio: "inherit",
  });
  return true;
}

/** Candidacy for the branch the arguments name, asking GitHub for its open PR. */
export function candidacyFromArgs(args, env = process.env) {
  const at = args.indexOf("--branch");
  const branch = at === -1 ? env.GITHUB_REF_NAME : args[at + 1];
  if (!branch) throw new Error(at === -1 ? "GITHUB_REF_NAME is not set." : "--branch needs a value.");
  const final = args.includes("--final");
  return isCandidate({
    branch,
    final,
    openPr: !final && !finalPublished({ cwd: ROOT, branch }) && openReleasePr(branch),
    carriesFinal: () => headCarriesFinal({ branch }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const candidate = candidacyFromArgs(process.argv.slice(2));
    console.log(`release-version: the release PR versions ${candidate ? "candidates" : "finals"}.`);
    setOutput("candidate", candidate);
  } catch (error) {
    console.error(`::error::release-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
