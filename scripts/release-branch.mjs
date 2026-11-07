#!/usr/bin/env node
// Release branches: which one is live, and the refusals the Cut, Finish and
// Publish workflows make before they do anything.
//
// At most one `release/<major>.<minor>` branch publishes: the newest. Every
// refusal below names its cause in the words the release procedure promises
// (RELEASING.md), and every one is decided from git alone, so it is the same
// whether a workflow or a maintainer's checkout asks.
//
// A branch is read at its remote ref (`origin/release/…`) when there is one and at
// the local ref otherwise: a CI checkout fetches every branch as a remote ref and
// has only the one it checked out locally.
//
// Usage:
//   node scripts/release-branch.mjs cut-check --ref <branch>      Cut release, before anything
//   node scripts/release-branch.mjs cut-prepare                   Cut release, deletes what the branch carries
//   node scripts/release-branch.mjs finish-check --ref <branch>   Finish release
//   node scripts/release-branch.mjs publish-check --ref <branch>  every Publish job
//   node scripts/release-branch.mjs branch-point --head <ref>     reads a cut PR's commits (JSON) on stdin

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { refuse, setOutput } from "./release-actions-output.mjs";
import { ROOT, compareVersions, teloGeneration } from "./version-line.mjs";

export const RELEASE_BRANCH = /^release\/(\d+)\.(\d+)$/;
const FINAL_TAG = /^v\d+\.\d+\.\d+$/;
const CLI_MANIFEST = "cli/nodejs/package.json";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined;
  }
}

/** Every `release/<major>.<minor>` branch, oldest first. */
export function releaseBranches(cwd = ROOT) {
  const refs = git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads/release", "refs/remotes/origin/release");
  const names = new Set(
    refs
      .split("\n")
      .map((ref) => ref.replace(/^refs\/(?:heads|remotes\/origin)\//, ""))
      .filter((name) => RELEASE_BRANCH.test(name)),
  );
  return [...names]
    .map((name) => {
      const [, major, minor] = RELEASE_BRANCH.exec(name);
      return { name, major: Number(major), minor: Number(minor) };
    })
    .sort((a, b) => a.major - b.major || a.minor - b.minor);
}

/** The newest release branch — the only one that publishes — or undefined. */
export function liveBranch(cwd = ROOT) {
  return releaseBranches(cwd).at(-1);
}

function refOf(cwd, branch) {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    if (tryGit(cwd, "show-ref", "--verify", "--quiet", ref) !== undefined) return ref;
  }
  throw new Error(`${branch} is not a branch of this checkout.`);
}

function readAt(cwd, ref, path) {
  return tryGit(cwd, "show", `${ref}:${path}`);
}

function listAt(cwd, ref, dir) {
  const out = tryGit(cwd, "ls-tree", "--name-only", ref, `${dir}/`);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** What a branch holds that no release has carried yet: changeset files not
 *  already consumed by a candidate, then module fragments. */
function unreleasedFiles(cwd, ref) {
  const pre = readAt(cwd, ref, ".changeset/pre.json");
  const consumed = new Set(pre ? (JSON.parse(pre).changesets ?? []) : []);
  const changesets = listAt(cwd, ref, ".changeset").filter((path) => {
    const file = basename(path);
    return file.endsWith(".md") && file !== "README.md" && !consumed.has(file.slice(0, -3));
  });
  const fragments = listAt(cwd, ref, ".changes/pending").filter((path) => !basename(path).startsWith("."));
  return [...changesets, ...fragments];
}

function isAncestor(cwd, commit, tip) {
  try {
    git(cwd, "merge-base", "--is-ancestor", commit, tip);
    return true;
  } catch {
    return false;
  }
}

/** The branch's newest final tag, `v<x>.<y>.<z>`; candidates are never merged back. */
function newestFinalTag(cwd, ref) {
  const tags = git(cwd, "tag", "--merged", ref, "--list", "v*")
    .split("\n")
    .filter((tag) => FINAL_TAG.test(tag));
  return tags.sort((a, b) => compareVersions(a.slice(1), b.slice(1))).at(-1);
}

/** The branch's newest numbered release tag of `kind` (`modules` or `packages`). */
function newestNumberedTag(cwd, branch, kind) {
  const [, major, minor] = RELEASE_BRANCH.exec(branch.name);
  const prefix = `${kind}-${major}.${minor}-`;
  const tags = git(cwd, "tag", "--list", `${prefix}*`)
    .split("\n")
    .filter((tag) => new RegExp(`^${kind}-\\d+\\.\\d+-\\d+$`).test(tag));
  return tags.sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length))).at(-1);
}

/**
 * Why Cut release must not run now, or undefined. The checks run in the order a
 * maintainer would fix them: the live branch first (finish it, publish it, merge
 * its tags back), then what main would cut.
 */
export async function cutRefusal({ cwd = ROOT, ref, generation = () => teloGeneration() }) {
  if (ref !== "main") return `Error: Cut release runs on main; ${ref} is not main.`;

  const plan = await generation();
  const live = liveBranch(cwd);
  const planned = /^(\d+)\.(\d+)\.\d+/.exec(plan.next);
  const fromMain = plan.bump && plan.bump !== "patch" ? { major: Number(planned[1]), minor: Number(planned[2]) } : undefined;
  const fromLive = live ? { major: live.major, minor: live.minor + 1 } : undefined;
  // The release a cut would make: the later of what main plans and the one after the live branch.
  const next = [fromMain, fromLive].filter(Boolean).sort((a, b) => a.major - b.major || a.minor - b.minor).at(-1);
  const label = next ? `${next.major}.${next.minor}` : "the next release";

  if (live) {
    const liveRef = refOf(cwd, live.name);
    if (readAt(cwd, liveRef, ".changeset/pre.json") !== undefined) {
      const version = JSON.parse(readAt(cwd, liveRef, CLI_MANIFEST) ?? "{}").version ?? "unreleased";
      return `Error: ${live.name} is in candidates (${version}). Finish it before cutting ${label}.`;
    }
    const [unreleased] = unreleasedFiles(cwd, liveRef);
    if (unreleased) {
      return `Error: ${live.name} holds unreleased changes (${unreleased}). Publish them before cutting ${label}.`;
    }
    const final = newestFinalTag(cwd, liveRef);
    if (final && !isAncestor(cwd, final, "HEAD")) {
      return `Error: main does not contain ${final}. Merge "chore(release): merge ${final} into main" first.`;
    }
    for (const kind of ["modules", "packages"]) {
      const tag = newestNumberedTag(cwd, live, kind);
      if (tag && !isAncestor(cwd, tag, "HEAD")) {
        return `Error: main does not contain ${tag}. Merge "chore(release): merge ${tag} into main" first.`;
      }
    }
  }

  if (!plan.bump) {
    return "Error: main's changesets plan no release. Add a minor changeset before cutting.";
  }
  if (plan.bump === "patch") {
    return `Error: main's changesets plan ${plan.next}, a patch. Add a minor changeset before cutting.`;
  }
  const plannedLabel = `${fromMain.major}.${fromMain.minor}`;
  if (releaseBranches(cwd).some((branch) => branch.name === `release/${plannedLabel}`)) {
    return `Error: release/${plannedLabel} already exists. Land the change on it, or add a changeset for the next minor.`;
  }
  return undefined;
}

/**
 * Delete what the new branch will carry from `cwd`'s working tree: the pending
 * changesets and module fragments. Returns how many of each, and the commit the
 * deletion sits on — the branch's start.
 */
export function cutPrepare(cwd = ROOT) {
  const changesetDir = join(cwd, ".changeset");
  const fragmentDir = join(cwd, ".changes", "pending");
  const changesets = existsSync(changesetDir)
    ? readdirSync(changesetDir).filter((file) => file.endsWith(".md") && file !== "README.md")
    : [];
  const fragments = existsSync(fragmentDir)
    ? readdirSync(fragmentDir).filter((file) => !file.startsWith("."))
    : [];
  for (const file of changesets) rmSync(join(changesetDir, file));
  for (const file of fragments) rmSync(join(fragmentDir, file));
  return { changesets: changesets.length, fragments: fragments.length, parent: git(cwd, "rev-parse", "HEAD") };
}

/** Why Finish release must not run at `ref`, or undefined. `cwd` is the checkout
 *  of `ref` itself: the file asked about is the branch's own. */
export function finishRefusal({ cwd = ROOT, ref }) {
  if (!RELEASE_BRANCH.test(ref)) {
    return `Error: Finish release runs on a release/* branch in candidates; ${ref} is not one.`;
  }
  const file = join(cwd, ".changeset", "pre.json");
  if (!existsSync(file)) {
    return `Error: ${ref} holds no .changeset/pre.json, so it is not in candidates.`;
  }
  if (JSON.parse(readFileSync(file, "utf8")).mode === "exit") {
    const [, major, minor] = RELEASE_BRANCH.exec(ref);
    return `Error: ${ref} has already exited candidates; merge its Version PR to publish ${major}.${minor}.0.`;
  }
  return undefined;
}

/** Why a Publish job must not run at `ref`, or undefined: it is no release
 *  branch, or a newer one was cut and this one is frozen. */
export function publishRefusal({ cwd = ROOT, ref }) {
  if (!RELEASE_BRANCH.test(ref)) return `Error: Publish runs on a release/* branch; ${ref} is not one.`;
  const live = liveBranch(cwd);
  const [, major, minor] = RELEASE_BRANCH.exec(ref);
  if (live && (live.major > Number(major) || (live.major === Number(major) && live.minor > Number(minor)))) {
    return `Error: ${ref} is frozen: ${live.name} was cut from main. Land the fix on ${live.name}.`;
  }
  return undefined;
}

/**
 * The branch a merged cut PR creates and where: `release/<x>.<y>` at the parent
 * of the PR's first commit — the cut commit — so main's tip as the cut was opened.
 * `commits` is the PR's commit list as the API returns it.
 */
export function cutBranchPoint({ head, commits }) {
  const match = /^release-cut\/(\d+\.\d+)$/.exec(head);
  if (!match) throw new Error(`${head} is not a release-cut/<major>.<minor> branch.`);
  const [first] = commits;
  const subject = first?.commit?.message?.split("\n")[0];
  if (subject !== `chore(release): cut ${match[1]}`) {
    throw new Error(`the first commit of ${head} is "${subject}", not the cut commit "chore(release): cut ${match[1]}".`);
  }
  const parent = first.parents?.[0]?.sha;
  if (!parent) throw new Error(`the cut commit of ${head} has no parent.`);
  return { branch: `release/${match[1]}`, sha: parent };
}

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

async function main() {
  const [command] = process.argv.slice(2);
  switch (command) {
    case "cut-check": {
      const refusal = await cutRefusal({ ref: argument("ref") });
      if (refusal) refuse(refusal);
      const plan = await teloGeneration();
      const [, major, minor] = /^(\d+)\.(\d+)\./.exec(plan.next);
      setOutput("release", `${major}.${minor}`);
      return;
    }
    case "cut-prepare": {
      const { changesets, fragments, parent } = cutPrepare();
      setOutput("changesets", changesets);
      setOutput("fragments", fragments);
      setOutput("parent", parent);
      return;
    }
    case "finish-check": {
      const ref = argument("ref");
      const refusal = finishRefusal({ ref });
      if (refusal) refuse(refusal);
      setOutput("release", ref.slice("release/".length));
      return;
    }
    case "publish-check": {
      const refusal = publishRefusal({ ref: argument("ref") });
      if (refusal) refuse(refusal);
      return;
    }
    case "branch-point": {
      const commits = JSON.parse(readFileSync(0, "utf8"));
      const { branch, sha } = cutBranchPoint({ head: argument("head"), commits });
      setOutput("branch", branch);
      setOutput("sha", sha);
      return;
    }
    default:
      throw new Error(`unknown command '${command ?? ""}'.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::release-branch: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
