#!/usr/bin/env node
// What kind of release a Publish run is, and the names that follow from it.
//
//   candidate  the telo line moved to `0.85.0-rc.<k>`
//   final      the line's first release of a minor — `0.85.0`
//   patch      any later release of the line — `0.85.1`
//   none       the line did not move: packages, images or modules released alone,
//              tagged `packages-<major>.<minor>-[rc.]<n>` (and, for modules,
//              `modules-<major>.<minor>-[rc.]<n>`)
//
// It reads the units the run's release commit moved (`release-units.mjs`), never
// the release PR that produced them, so a re-run of an old publish classifies the
// same way. The line is the units' group holding `@telorun/analyzer`, so whether
// the line moved is whether that package is among them; a release is a candidate
// when it versions its units as candidates (`<final>-rc.<k>`).
//
// Usage:
//   node scripts/release-channel.mjs classify          env MOVED_UNITS, GITHUB_REF_NAME
//   node scripts/release-channel.mjs modules-tag       env GITHUB_REF_NAME, CANDIDATES

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { releaseCommitOf, tagsOfReleaseCommit } from "./release-commit.mjs";
import { releaseCommit } from "./release-units.mjs";
import { ROOT, compareVersions } from "./version-line.mjs";

/** The npm package whose unit's group is the telo line. */
const LINE_PACKAGE = "@telorun/analyzer";
const RELEASE_BRANCH = /^release\/(\d+\.\d+)$/;
/** The tags naming a release; a unit's own `<key>@<version>` tag is not one. */
const RELEASE_TAGS = ["refs/tags/v*", "refs/tags/packages-*", "refs/tags/modules-*"];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `channel` of a release whose line moved to `cliVersion`. */
export function channelOf({ cliVersion }) {
  if (/-/.test(cliVersion)) return "candidate";
  return cliVersion.endsWith(".0") ? "final" : "patch";
}

/**
 * The release a Publish run at `cwd`'s HEAD made, from the `units` its release
 * commit moved (`[{ key, name, version, ecosystem }]`):
 * `{ channel, version, tag, releaseTag, candidates, recordTag, released }`. `tag` is the
 * line's `v<version>`; `releaseTag` is what the run tags (that, or the numbered
 * `packages-*` when units other than modules moved without the line); `recordTag`
 * is what main records — the release tag, empty for a candidate. A release commit
 * a release tag already names — or, for a packages release, one a packages tag of the
 * branch contains — is released, so a run at a later commit of the branch releases
 * nothing; a re-run at the commit the tags name finds them again.
 */
export function classifyRelease({ cwd = ROOT, units = [], branch }) {
  const none = { channel: "none", version: "", tag: "", releaseTag: "", candidates: false, recordTag: "", released: false };
  if (units.length === 0) return none;
  const head = git(cwd, "rev-parse", "HEAD");
  const commit = releaseCommit({ cwd });
  if (commit && commit !== head && tagsOfReleaseCommit({ cwd, commit, patterns: RELEASE_TAGS }).length > 0) return none;
  const candidates = units.some((unit) => /-/.test(unit.version));
  const line = units.find((unit) => unit.ecosystem === "npm" && unit.name === LINE_PACKAGE);
  if (line) {
    const channel = channelOf({ cliVersion: line.version });
    const tag = `v${line.version}`;
    // The line's tag names one release: a later commit of the branch releases nothing by it.
    if (git(cwd, "tag", "--list", tag) && releaseCommitOf({ cwd, tag }) !== head) return none;
    return { channel, version: line.version, tag, releaseTag: tag, candidates, recordTag: candidates ? "" : tag, released: true };
  }
  if (!units.some((unit) => unit.ecosystem !== "telo")) return { ...none, candidates, released: true };
  const packages = numberedTag({ cwd, branch, kind: "packages", candidate: candidates });
  // A packages tag a later commit of the branch made has released it, unless it names HEAD.
  if (!packages.existing && commit && seriesTags({ cwd, branch, kind: "packages", candidate: candidates, contains: commit }).tags.length > 0) {
    return none;
  }
  return { ...none, releaseTag: packages.tag, candidates, recordTag: candidates ? "" : packages.tag, released: true };
}

/** The branch's `<kind>-<x.y>-[rc.]<n>` tags, those containing `contains` when given. */
function seriesTags({ cwd, branch, kind, candidate, contains }) {
  const match = RELEASE_BRANCH.exec(branch ?? "");
  if (!match) throw new Error(`${branch} is not a release/<major>.<minor> branch.`);
  const prefix = `${kind}-${match[1]}-${candidate ? "rc." : ""}`;
  const own = new RegExp(`^${prefix.replace(/\./g, "\\.")}\\d+$`);
  const listed = git(cwd, "tag", ...(contains ? ["--contains", contains] : []), "--list", `${prefix}*`);
  return { prefix, tags: listed.split("\n").filter((tag) => own.test(tag)) };
}

/** Number of the branch's next `modules-` or `packages-` release tag — a candidate's
 *  `<kind>-<x.y>-rc.<n>` counted apart from the finals' `<kind>-<x.y>-<n>` — and the
 *  tag naming HEAD as its release commit if a re-run finds one, on HEAD or on its
 *  publication commit. `branch` is `release/<major>.<minor>`. */
export function numberedTag({ cwd = ROOT, branch, kind, candidate = false }) {
  const { prefix, tags: existing } = seriesTags({ cwd, branch, kind, candidate });
  const onHead = tagsOfReleaseCommit({ cwd, commit: "HEAD", patterns: [`refs/tags/${prefix}*`] }).filter((tag) => existing.includes(tag));
  return { tag: onHead[0] ?? `${prefix}${existing.length + 1}`, existing: onHead.length > 0 };
}

export const modulesTag = ({ cwd, branch, candidate }) => numberedTag({ cwd, branch, kind: "modules", candidate });

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
      let units;
      try {
        units = JSON.parse(process.env.MOVED_UNITS || "[]");
      } catch (error) {
        throw new Error(`MOVED_UNITS is not valid JSON: ${error.message}`);
      }
      const release = classifyRelease({ units: Array.isArray(units) ? units : [], branch: process.env.GITHUB_REF_NAME });
      setOutput("channel", release.channel);
      setOutput("version", release.version);
      setOutput("tag", release.tag);
      setOutput("release-tag", release.releaseTag);
      setOutput("candidates", release.candidates);
      setOutput("record-tag", release.recordTag);
      setOutput("released", release.released);
      return;
    }
    case "modules-tag": {
      const { tag, existing } = modulesTag({ branch: process.env.GITHUB_REF_NAME, candidate: process.env.CANDIDATES === "true" });
      setOutput("tag", tag);
      setOutput("existing", existing);
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
