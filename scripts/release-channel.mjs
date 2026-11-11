#!/usr/bin/env node
// What kind of release a Publish run is, and the names that follow from it.
//
//   candidate  `.changeset/pre.json` in prerelease mode — `0.85.0-rc.N`
//   final      the release's first publish — `0.85.0`
//   patch      any later publish of the branch — `0.85.1`
//   none       packages published without the CLI (no `v<version>` to name it); a
//              branch release of them is tagged `packages-<major>.<minor>-<n>`. A
//              commit moving the CLI to a version `v<version>` already tags elsewhere
//              (main's record of a release) releases no CLI either.
//
// The channel is read from the tree the run publishes, not from the Version PR that
// produced it, so a re-run of an old publish classifies the same way.
//
// Usage:
//   node scripts/release-channel.mjs pack-tag                  the tag this run's pack links name, before publishing
//   node scripts/release-channel.mjs classify                  env PUBLISHED_PACKAGES
//   node scripts/release-channel.mjs modules-tag               tag a module release of this branch
//   node scripts/release-channel.mjs modules-ready             may the release PR version modules?

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { releaseCommitOf, tagsOfReleaseCommit } from "./release-commit.mjs";
import { newestVersionCommit } from "./version-commit.mjs";
import { ROOT, compareVersions, readPreState, readReleasePlan } from "./version-line.mjs";

const CLI = "@telorun/cli";
const CLI_MANIFEST = "cli/nodejs/package.json";
const RELEASE_BRANCH = /^release\/(\d+\.\d+)$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `channel` of a release whose CLI is at `cliVersion`. */
export function channelOf({ preMode, cliVersion }) {
  if (preMode === "pre" || /-/.test(cliVersion)) return "candidate";
  return cliVersion.endsWith(".0") ? "final" : "patch";
}

const cliVersionAt = (cwd, ref) => JSON.parse(git(cwd, "show", `${ref}:${CLI_MANIFEST}`)).version;

/** Did `sha` move the CLI's version against its parent — is it a Version PR merge. */
function cliMovedIn(cwd, sha) {
  try {
    return cliVersionAt(cwd, `${sha}^`) !== cliVersionAt(cwd, sha);
  } catch {
    return false;
  }
}

/**
 * The commit that released the CLI in the run at `cwd`'s HEAD, or undefined. It is the
 * newest version commit (`version-commit.mjs`) — the tip, or the Version PR merge a fix
 * was pushed on top of — and it released the CLI unless `v<version>` already names
 * another release (a record on main moves the version to one already released, so a
 * branch cut at it releases nothing by it; a tag on the version's own publication commit
 * names the run's HEAD, so a re-run classifies as the first run did).
 */
export function cliVersionCommit({ cwd = ROOT } = {}) {
  const commit = newestVersionCommit({ cwd, paths: [CLI_MANIFEST], moves: (sha) => cliMovedIn(cwd, sha) });
  if (!commit) return undefined;
  const tag = `v${cliVersionAt(cwd, commit)}`;
  if (!git(cwd, "tag", "--list", tag)) return commit;
  return releaseCommitOf({ cwd, tag }) === git(cwd, "rev-parse", "HEAD") ? commit : undefined;
}

/**
 * The tag a Publish run at `cwd`'s HEAD names its release by, known before anything
 * publishes: `v<cli version>` when the commit released the CLI, else (outside
 * candidates, on a `release/<major>.<minor>` branch) the numbered
 * `packages-<major>.<minor>-<n>`; empty otherwise.
 */
export function plannedTag({ cwd = ROOT, branch }) {
  const released = cliVersionCommit({ cwd });
  if (released) return `v${cliVersionAt(cwd, released)}`;
  if (existsSync(join(cwd, ".changeset", "pre.json")) || !RELEASE_BRANCH.test(branch ?? "")) return "";
  return numberedTag({ cwd, branch, kind: "packages" }).tag;
}

/**
 * The release a Publish run at `cwd`'s HEAD made:
 * `{ channel, version, tag, releaseTag, candidates, recordTag }`. `tag` is the CLI's
 * `v<version>`; `releaseTag` is what the run tags (that, or `packages-*` for
 * packages published without the CLI); `recordTag` is what main records — the
 * release tag; empty for a candidate and for a run that released nothing.
 */
export function classifyPublish({ cwd = ROOT, published = [], branch }) {
  const pre = existsSync(join(cwd, ".changeset", "pre.json"))
    ? JSON.parse(readFileSync(join(cwd, ".changeset", "pre.json"), "utf8"))
    : undefined;
  const none = { channel: "none", version: "", tag: "", releaseTag: "", candidates: pre !== undefined, recordTag: "" };
  const released = cliVersionCommit({ cwd });
  if (released) {
    const cliVersion = cliVersionAt(cwd, released);
    const channel = channelOf({ preMode: pre?.mode, cliVersion });
    const tag = `v${cliVersion}`;
    return { channel, version: cliVersion, tag, releaseTag: tag, candidates: pre !== undefined, recordTag: channel === "candidate" ? "" : tag };
  }
  const releasedOthers = published.some((pkg) => pkg.name !== CLI);
  if (!releasedOthers || pre !== undefined) return none;
  const releaseTag = plannedTag({ cwd, branch });
  return { ...none, releaseTag, recordTag: releaseTag };
}

/** Number of the branch's next `modules-` or `packages-` release tag, and the tag
 *  naming HEAD as its release commit if a re-run finds one — on HEAD or on its
 *  publication commit. `branch` is `release/<major>.<minor>`. */
export function numberedTag({ cwd = ROOT, branch, kind }) {
  const match = RELEASE_BRANCH.exec(branch);
  if (!match) throw new Error(`${branch} is not a release/<major>.<minor> branch.`);
  const prefix = `${kind}-${match[1]}-`;
  const existing = git(cwd, "tag", "--list", `${prefix}*`).split("\n").filter(Boolean);
  const onHead = tagsOfReleaseCommit({ cwd, commit: "HEAD", patterns: [`refs/tags/${prefix}*`] });
  return { tag: onHead[0] ?? `${prefix}${existing.length + 1}`, existing: onHead.length > 0 };
}

export const modulesTag = ({ cwd, branch }) => numberedTag({ cwd, branch, kind: "modules" });

/** May the release PR version the modules: no candidates, and no changeset still to publish. */
export async function modulesReady() {
  if (readPreState()) return { ready: false, reason: ".changeset/pre.json exists: modules publish after the final" };
  const plan = await readReleasePlan();
  const pending = plan.releases.filter((r) => r.type !== "none" && r.newVersion !== r.oldVersion);
  if (pending.length > 0) {
    return { ready: false, reason: `the branch's changesets still plan ${pending.length} release(s)` };
  }
  return { ready: true, reason: "" };
}

/**
 * GitHub Release flags for a channel. Only a final or patch may be `latest`, and
 * only when the current latest release is not a higher version — a publish never
 * moves a pointer backwards. `latestTag` is the tag of today's latest release.
 */
export function githubReleaseFlags({ channel, version, latestTag }) {
  if (channel === "candidate") return { prerelease: true, makeLatest: "false" };
  const superseded = latestTag && compareVersions(latestTag.replace(/^v/, ""), version) > 0;
  return { prerelease: false, makeLatest: superseded ? "false" : "true" };
}

async function main() {
  const [command] = process.argv.slice(2);
  switch (command) {
    case "classify": {
      let published = [];
      try {
        published = JSON.parse(process.env.PUBLISHED_PACKAGES || "[]");
      } catch (error) {
        throw new Error(`PUBLISHED_PACKAGES is not valid JSON: ${error.message}`);
      }
      const release = classifyPublish({ published: Array.isArray(published) ? published : [], branch: process.env.GITHUB_REF_NAME });
      setOutput("channel", release.channel);
      setOutput("version", release.version);
      setOutput("tag", release.tag);
      setOutput("release-tag", release.releaseTag);
      setOutput("candidates", release.candidates);
      setOutput("record-tag", release.recordTag);
      return;
    }
    case "pack-tag": {
      setOutput("tag", plannedTag({ branch: process.env.GITHUB_REF_NAME }));
      return;
    }
    case "modules-tag": {
      const { tag, existing } = modulesTag({ branch: process.env.GITHUB_REF_NAME });
      setOutput("tag", tag);
      setOutput("existing", existing);
      return;
    }
    case "modules-ready": {
      const { ready, reason } = await modulesReady();
      if (!ready) console.log(`Release PR: not versioning modules — ${reason}.`);
      setOutput("ready", ready);
      return;
    }
    default:
      throw new Error(`unknown command '${command ?? ""}'.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::release-channel: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
