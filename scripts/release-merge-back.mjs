#!/usr/bin/env node
// Opens the PR that takes a published release back into main.
//
// The PR merges the release TAG (`v*`, `modules-*` or `packages-*`), not the branch
// tip, so a fix landed after the publish does not reach main with its changeset and
// release twice. The head branch is created at the tag; it lands with a merge commit
// so main's ledger holds every published version.
//
// The refs and the PR are created with the token in GH_TOKEN (the bot token): a PR
// opened with the default token starts no checks.
//
// Usage: node scripts/release-merge-back.mjs <tag>

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT } from "./version-line.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

/** The PR a release `name` (its tag) opens. */
export function mergeBackPlan(name) {
  return {
    branch: `merge-back/${name}`,
    title: `chore(release): merge ${name} into main`,
    body: [
      `Takes the published \`${name}\` back into main, so main's changeset and module ledgers hold what shipped.`,
      "",
      "**Land this with a merge commit** — not a squash and not a rebase: main must contain the release's commits for the next cut to see them.",
      "",
      "A conflict is resolved by hand in this PR, keeping the release's versions and main's other edits.",
    ].join("\n"),
  };
}

/** Whether main already holds `ref`'s commit, so there is nothing to merge back. */
export function containedInMain({ cwd = ROOT, ref }) {
  try {
    git(cwd, "merge-base", "--is-ancestor", ref, "origin/main");
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [ref] = process.argv.slice(2);
    if (!ref) throw new Error("usage: release-merge-back.mjs <tag>");
    const repository = process.env.GITHUB_REPOSITORY;
    const plan = mergeBackPlan(ref);
    const sha = git(ROOT, "rev-list", "-n", "1", ref);

    if (containedInMain({ ref })) {
      console.log(`release-merge-back: main already contains ${ref}; nothing to open.`);
    } else if (gh("pr", "list", "--head", plan.branch, "--state", "all", "--json", "number", "--jq", "length") !== "0") {
      console.log(`release-merge-back: a pull request for ${plan.branch} already exists; not opening a second.`);
    } else {
      try {
        gh("api", "-X", "POST", `repos/${repository}/git/refs`, "-f", `ref=refs/heads/${plan.branch}`, "-f", `sha=${sha}`);
      } catch (error) {
        // The branch survives a run that failed before opening the PR; at the same commit it is reused.
        const have = gh("api", `repos/${repository}/git/ref/heads/${plan.branch}`, "--jq", ".object.sha");
        if (have !== sha) throw error;
      }
      const url = gh("pr", "create", "--base", "main", "--head", plan.branch, "--title", plan.title, "--body", plan.body);
      console.log(`release-merge-back: opened ${url} "${plan.title}".`);
    }
  } catch (error) {
    console.error(`::error::release-merge-back: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
