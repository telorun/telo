#!/usr/bin/env node
// The `stable` branch: one ref, always at the publication commit of the newest final
// release (`v<x.y.z>`), so a URL into `stable` serves the examples, starters and
// installer exactly as that release tag does, with pins to published artifacts.
//
// It moves like `latest` (`release-pointers.mjs`): forward only, compared against the
// repository's own final tags, never for a candidate, and never for a `modules-*` or
// `packages-*` release. The push is forced because successive publication commits are
// siblings, each a child of its own release commit; a re-run at the same commit pushes
// the same sha and changes nothing. Nobody commits to the branch and nothing merges into it.
//
// Usage: node scripts/release-stable.mjs --tag <tag> --sha <publication commit>
//        (GH_TOKEN and GITHUB_REPOSITORY push with the token, as `release-tag.mjs` does)

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { channelOf } from "./release-channel.mjs";
import { pointerMoves } from "./release-pointers.mjs";
import { pushTarget } from "./release-tag.mjs";
import { ROOT } from "./version-line.mjs";

const FINAL_TAG = /^v(\d+\.\d+\.\d+)$/;

/** Whether the release tagged `tag` may move `stable`, given the repository's `v*` tags. */
export function stableMoves({ tag, tags }) {
  const match = FINAL_TAG.exec(tag);
  if (!match) return false;
  const version = match[1];
  return pointerMoves({ version, channel: channelOf({ cliVersion: version }), tags }).latest;
}

/** Pushes `sha` to `stable` of `cwd`'s remote when `tag` may move it; whether it did. */
export function moveStable({ tag, sha, tags, cwd = ROOT }) {
  if (!stableMoves({ tag, tags })) return false;
  const { remote, env } = pushTarget();
  execFileSync("git", ["push", "--quiet", "--force", remote, `${sha}:refs/heads/stable`], { cwd, env, stdio: "inherit" });
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2);
    const flag = (name) => args[args.indexOf(name) + 1];
    const tag = args.includes("--tag") ? flag("--tag") : "";
    const sha = args.includes("--sha") ? flag("--sha") : "";
    if (!tag || !sha) throw new Error("usage: release-stable.mjs --tag <tag> --sha <commit>");
    const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    console.error(moveStable({ tag, sha, tags }) ? `stable -> ${sha} (${tag})` : `stable stays: ${tag} is not the newest final release.`);
  } catch (error) {
    console.error(`::error::release-stable: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
