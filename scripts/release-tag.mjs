#!/usr/bin/env node
// Tags a release commit. A re-run finds the tag it made and does nothing; a tag
// that names another commit is a conflict, never moved.
//
// The tag is created through the API (`gh api`) with the token in GH_TOKEN, since
// the rulesets let only the release workflows create `v*`, `modules-*` and `packages-*` tags.
//
// Usage: node scripts/release-tag.mjs <tag> [<sha>]      (sha defaults to HEAD)

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT } from "./version-line.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createWithGh(tag, sha) {
  execFileSync(
    "gh",
    ["api", "-X", "POST", `repos/${process.env.GITHUB_REPOSITORY}/git/refs`, "-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`],
    { stdio: "inherit" },
  );
}

/** `created` or `exists`. `create(tag, sha)` makes the tag on the remote. */
export function ensureTag({ cwd = ROOT, tag, sha, create = createWithGh }) {
  let at;
  try {
    at = git(cwd, "rev-list", "-n", "1", `refs/tags/${tag}`);
  } catch {
    at = undefined;
  }
  if (at === undefined) {
    create(tag, sha);
    return "created";
  }
  if (at !== sha) {
    throw new Error(`${tag} already names ${at}, not ${sha}. A release tag is never moved.`);
  }
  return "exists";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [tag, sha = git(ROOT, "rev-parse", "HEAD")] = process.argv.slice(2);
    if (!tag) throw new Error("usage: release-tag.mjs <tag> [<sha>]");
    console.log(`release-tag: ${tag} ${ensureTag({ tag, sha })} at ${sha}.`);
  } catch (error) {
    console.error(`::error::release-tag: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
