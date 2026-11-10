#!/usr/bin/env node
// Which shared pointers a release may move: Docker's `latest`, `<major>` and
// `<major>.<minor>` tags, Studio pages, the VS Code Marketplace.
//
// A pointer moves only forward. The comparison is against the repo's own final
// tags (`v<major>.<minor>.<patch>`, created by the Publish run before anything
// downstream), not against what a registry holds, so it needs no registry
// credentials and answers the same for every pointer: a pointer may move to a
// version when no final tag names a higher one in the pointer's scope. Re-running
// an old publish therefore moves nothing, and a candidate moves no pointer at all.
//
// An app image (hub, docker-runner, hub-web, k8s-runner, authoring-agent) has a
// version of its own, so its `latest` is judged by that, not by the CLI's: it moves
// when no release tag (`v*`, `modules-*`, `packages-*`) holds a higher version of
// the image's own version file. The tags are the repo's record of what published,
// so this too needs no registry credentials, and a re-run of an old publish moves
// nothing.
//
// Usage: node scripts/release-pointers.mjs --version 0.85.0 [--channel final]
//        (outputs `channel` and `latest`, `major`, `minor`: `true` | `false`; tags from `git tag`)
//        node scripts/release-pointers.mjs image --file apps/hub/telo.yaml
//        (outputs `latest`)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { ROOT, compareVersions } from "./version-line.mjs";
import { channelOf } from "./release-channel.mjs";
import { releaseCommitsOf } from "./release-commit.mjs";

const FINAL_TAG = /^v(\d+\.\d+\.\d+)$/;

/** The versions of the final tags among `tags` (a candidate's tag is not one). */
export function finalVersions(tags) {
  return tags.flatMap((tag) => {
    const match = FINAL_TAG.exec(tag);
    return match ? [match[1]] : [];
  });
}

/**
 * Which pointers `version` may move: `latest` (all finals), `major` (finals of its
 * major) and `minor` (finals of its major.minor). A candidate moves none.
 */
export function pointerMoves({ version, channel, tags }) {
  if (channel === "candidate") return { latest: false, major: false, minor: false };
  const finals = finalVersions(tags);
  const none = (inScope) => !finals.some((other) => inScope(other) && compareVersions(other, version) > 0);
  const [major, minor] = version.split(".");
  return {
    latest: none(() => true),
    major: none((other) => other.split(".")[0] === major),
    minor: none((other) => other.split(".").slice(0, 2).join(".") === `${major}.${minor}`),
  };
}

/** The version an image's version file holds: `version` of a JSON manifest, or
 *  `metadata.version` of a `telo.yaml`. Undefined when it holds none. */
export function imageVersionOf(file, text) {
  if (file.endsWith(".json")) {
    const version = JSON.parse(text).version;
    return typeof version === "string" ? version : undefined;
  }
  return /^  version: ["']?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m.exec(text)?.[1];
}

/** Whether an image at `version` may move `latest`: no release tag holds a higher
 *  version of the same file. `tagVersions` are those versions. */
export function imageLatestMoves({ version, tagVersions }) {
  return !tagVersions.some((other) => compareVersions(other, version) > 0);
}

function releaseTagVersions(file) {
  const tags = releaseCommitsOf({ cwd: ROOT, patterns: ["refs/tags/v*", "refs/tags/modules-*", "refs/tags/packages-*"] });
  const commits = new Set(tags.values());
  const versions = new Set();
  for (const commit of commits) {
    try {
      const text = execFileSync("git", ["show", `${commit}:${file}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const version = imageVersionOf(file, text);
      if (version) versions.add(version);
    } catch {
      // the file did not exist at that release
    }
  }
  return [...versions];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2);
    const flag = (name) => args[args.indexOf(name) + 1];
    if (args[0] === "image") {
      const file = flag("--file");
      if (!file) throw new Error("usage: release-pointers.mjs image --file <version file>");
      const version = imageVersionOf(file, readFileSync(join(ROOT, file), "utf8"));
      if (!version) throw new Error(`${file} holds no version.`);
      setOutput("latest", imageLatestMoves({ version, tagVersions: releaseTagVersions(file) }));
      process.exit(0);
    }
    const version = args.includes("--version") ? flag("--version") : "";
    if (!version) throw new Error("usage: release-pointers.mjs --version <version> [--channel <channel>]");
    const channel = (args.includes("--channel") ? flag("--channel") : "") || channelOf({ cliVersion: version });
    const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const moves = pointerMoves({ version, channel, tags });
    setOutput("channel", channel);
    for (const [pointer, moves_] of Object.entries(moves)) setOutput(pointer, moves_);
  } catch (error) {
    console.error(`::error::release-pointers: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
