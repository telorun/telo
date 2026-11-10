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
// It is also the one reader of the release conventions the gates and the record
// share: which heads are the release machinery's own pull requests, a line's
// release tags and the newest of them.
//
// Usage:
//   pnpm exec bun scripts/release-branch.mjs cut-check --ref <branch>      Start release candidates, before anything
//   pnpm exec bun scripts/release-branch.mjs finish-check --ref <branch>   Publish final release
//   node scripts/release-branch.mjs create-branch --branch <b> --sha <s>   the cut's ref (env GH_TOKEN, GH_REPO)
//   node scripts/release-branch.mjs publish-check --ref <branch>           every Publish job
//   node scripts/release-branch.mjs gate-refs                              the PR gates' refs (GITHUB_* env)
//
// `cut-check`, and `finish-check` on main (a cut straight to the final), run under
// bun: they ask the record (`release-record.mjs`), which reads the analyzer from source.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { refuse, setOutput } from "./release-actions-output.mjs";
import { releaseCommitOf, releaseCommitsOf } from "./release-commit.mjs";
import { ROOT, finalPublished, teloGeneration } from "./version-line.mjs";

export const RELEASE_BRANCH = /^release\/(\d+)\.(\d+)$/;
const CLI_MANIFEST = "cli/nodejs/package.json";
const CANDIDATE_TAG = /^v\d+\.\d+\.\d+-/;
const MACHINERY_HEAD = /^(changeset-release|release-record)\//;
// Tags on one commit order by the run that made them: modules after packages after v.
const TAG_RANK = { v: 0, packages: 1, modules: 2 };

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

/** The head branch of a PR the release workflows open, or undefined: its own
 *  output, so the gates skip only the coverage it consumes. */
export function releaseMachineryHead(head = process.env.GITHUB_HEAD_REF) {
  return MACHINERY_HEAD.test(head ?? "") ? head : undefined;
}

/** The ref a branch is read at, short: `origin/<branch>` when fetched, else `<branch>`. */
export function branchRef(cwd, branch) {
  return refOf(cwd, branch).replace(/^refs\/(?:remotes\/|heads\/)/, "");
}

/**
 * The live branch's release tags — `v<major>.<minor>.<z>` (no candidate),
 * `packages-<major>.<minor>-<n>` and `modules-<major>.<minor>-<n>` whose release
 * commit (`release-commit.mjs`) its tip reaches — newest first: by the tip's history,
 * then by the run that made them.
 */
export function releaseTagsOf(cwd, branch) {
  const ref = refOf(cwd, branch.name);
  const line = `${branch.major}.${branch.minor}`;
  const escaped = `${branch.major}\\.${branch.minor}`;
  const shape = new RegExp(`^(?:v${escaped}\\.\\d+|(packages|modules)-${escaped}-\\d+)$`);
  const order = new Map(git(cwd, "rev-list", "--topo-order", ref).split("\n").map((sha, index) => [sha, index]));
  const number = (tag) => Number(/(\d+)$/.exec(tag)[1]);
  const tags = releaseCommitsOf({
    cwd,
    patterns: [`refs/tags/v${line}.*`, `refs/tags/packages-${line}-*`, `refs/tags/modules-${line}-*`],
  });
  return [...tags]
    .filter(([tag, release]) => shape.test(tag) && order.has(release))
    .map(([tag, release]) => ({
      tag,
      kind: tag.startsWith("v") ? "v" : tag.split("-")[0],
      position: order.get(release),
    }))
    .sort((a, b) => a.position - b.position || TAG_RANK[b.kind] - TAG_RANK[a.kind] || number(b.tag) - number(a.tag))
    .map(({ tag }) => tag);
}

/** The live branch's newest non-candidate release tag, or undefined. */
export function newestReleaseTag(cwd, branch) {
  return releaseTagsOf(cwd, branch)[0];
}

/**
 * The tag a record of `given` takes: the live branch's newest release tag, which
 * holds every earlier release's state. Refuses a candidate, a tag the live tip
 * does not reach, and a repository with no live branch or no release on it.
 */
export function recordTagFor({ cwd = ROOT, given }) {
  if (CANDIDATE_TAG.test(given)) {
    throw new Error(`${given} is a release candidate; a record takes a final, patch, packages or modules release.`);
  }
  const live = liveBranch(cwd);
  if (!live) throw new Error("no release/* branch exists, so there is nothing to record.");
  if (tryGit(cwd, "rev-parse", "--verify", "--quiet", `refs/tags/${given}`) === undefined) {
    throw new Error(`${given} is not a tag of this repository.`);
  }
  if (tryGit(cwd, "merge-base", "--is-ancestor", releaseCommitOf({ cwd, tag: given }), refOf(cwd, live.name)) === undefined) {
    throw new Error(`${given} is not reachable from ${live.name}; only the live branch's releases are recorded.`);
  }
  const newest = newestReleaseTag(cwd, live);
  if (!newest) throw new Error(`${live.name} has published no final, patch, packages or modules release yet.`);
  return { tag: newest, branch: live.name };
}

/** Whether main's tree already holds `tag`'s record: the record's check mode finds
 *  nothing to change. Run under bun (the record reads the analyzer from source). */
async function mainRecords(tag) {
  const { recordDifference } = await import("./release-record.mjs");
  return (await recordDifference({ tag })) === undefined;
}

/**
 * Why Start release candidates must not run now, or undefined. The checks run in the order a
 * maintainer would fix them: the live branch first (finish it, publish it, record
 * its newest release on main), then what main would cut.
 */
export async function cutRefusal({ cwd = ROOT, ref, generation = () => teloGeneration(), records = mainRecords }) {
  if (ref !== "main") return `Error: Start release candidates runs on main; ${ref} is not main.`;

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
    const newest = newestReleaseTag(cwd, live);
    if (newest && !(await records(newest))) {
      return `Error: main does not record ${newest}. Merge "chore(release): record ${newest} on main" first.`;
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

/** The `<major>.<minor>` a cut from main makes: the minor main's changesets plan. */
async function cutRelease(generation = () => teloGeneration()) {
  const [, major, minor] = /^(\d+)\.(\d+)\./.exec((await generation()).next);
  return `${major}.${minor}`;
}

/** Why Publish final release must not run at `ref`, or undefined. On main it cuts a
 *  release straight to its final, so it refuses what the cut refuses; elsewhere `cwd`
 *  is the checkout of `ref` itself, whose own `.changeset/pre.json` is asked about. */
export async function finishRefusal({ cwd = ROOT, ref, generation, records }) {
  if (ref === "main") return cutRefusal({ cwd, ref, generation, records });
  if (!RELEASE_BRANCH.test(ref)) {
    return `Error: Publish final release runs on main or on a release/* branch in candidates; ${ref} is neither.`;
  }
  const file = join(cwd, ".changeset", "pre.json");
  if (!existsSync(file)) {
    const [, major, minor] = RELEASE_BRANCH.exec(ref);
    if (finalPublished({ cwd, branch: ref })) {
      return `Error: ${ref} has published ${major}.${minor}.0 and takes patches only.`;
    }
    return `Error: ${ref} has published no candidate yet. Merge its rc Version PR ("chore(release): version") first, then finish.`;
  }
  return undefined;
}

function remoteRepository() {
  const repository = process.env.GH_REPO;
  if (!repository) throw new Error("GH_REPO is not set.");
  return repository;
}

/** The commit `branch` names on the remote, or undefined when it does not exist. */
function remoteBranchSha(branch) {
  try {
    return execFileSync("gh", ["api", `repos/${remoteRepository()}/git/ref/heads/${branch}`, "--jq", ".object.sha"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (/HTTP 404/.test(`${error.stderr ?? ""}`)) return undefined;
    throw error;
  }
}

function createRemoteBranch(branch, sha) {
  execFileSync("gh", ["api", "-X", "POST", `repos/${remoteRepository()}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha}`], {
    stdio: "inherit",
  });
}

/** Creates the release branch at `sha` on the remote: `created`, or `exists` when a
 *  re-run finds it there already. A branch at another commit is refused, never moved.
 *  The token in GH_TOKEN must be one the rulesets let create `release/*` refs. */
export function ensureBranch({ branch, sha, have = remoteBranchSha, create = createRemoteBranch }) {
  if (!RELEASE_BRANCH.test(branch)) throw new Error(`${branch} is not a release/<major>.<minor> branch.`);
  const at = have(branch);
  if (at === undefined) {
    create(branch, sha);
    return "created";
  }
  if (at !== sha) throw new Error(`${branch} already exists at ${at}, not at ${sha}.`);
  return "exists";
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
 * The refs `telo release check` takes on a PR or push: `base` is HEAD for a push
 * and for the release machinery's own PR (whose diff is the release), else the
 * PR's base; `carriedBy` is the live branch when the tree judged is main's, so a
 * fragment the branch already carries plans nothing there.
 */
export function gateRefs({ cwd = ROOT, event, base, head, ref }) {
  const pullRequest = event === "pull_request";
  const live = liveBranch(cwd);
  const onMain = pullRequest ? base === "main" : ref === "main";
  return {
    base: pullRequest && !releaseMachineryHead(head) ? `origin/${base}` : "HEAD",
    carriedBy: onMain && live ? branchRef(cwd, live.name) : "",
  };
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
      setOutput("release", await cutRelease());
      setOutput("live", liveBranch()?.name ?? "");
      return;
    }
    case "finish-check": {
      const ref = argument("ref");
      const refusal = await finishRefusal({ ref });
      if (refusal) refuse(refusal);
      const release = ref === "main" ? await cutRelease() : ref.slice("release/".length);
      setOutput("release", release);
      setOutput("branch", `release/${release}`);
      setOutput("direct", ref === "main");
      setOutput("live", liveBranch()?.name ?? "");
      return;
    }
    case "create-branch": {
      const branch = argument("branch");
      const sha = argument("sha");
      console.log(`release-branch: ${branch} ${ensureBranch({ branch, sha })} at ${sha}.`);
      return;
    }
    case "publish-check": {
      const refusal = publishRefusal({ ref: argument("ref") });
      if (refusal) refuse(refusal);
      return;
    }
    case "gate-refs": {
      const refs = gateRefs({
        event: process.env.GITHUB_EVENT_NAME,
        base: process.env.GITHUB_BASE_REF,
        head: process.env.GITHUB_HEAD_REF,
        ref: process.env.GITHUB_REF_NAME,
      });
      setOutput("base", refs.base);
      setOutput("carried-by", refs.carriedBy);
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
