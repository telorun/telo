#!/usr/bin/env node
// Tags a release: its release commit, or the publication commit made from it
// (`publication-commit.mjs`). A re-run finds the tag it made and does nothing; a tag
// that names another commit is a conflict, never moved.
//
// The tag is pushed with git (`<sha>:refs/tags/<tag>`), which also sends the commit
// when no branch of the remote holds it — a publication commit is on none. With
// GH_TOKEN and GITHUB_REPOSITORY set it pushes to `https://github.com/<repository>`
// with that token in place of the checkout's credentials, since the rulesets let only
// the release workflows create `v*`, `modules-*` and `packages-*` tags; without them it
// pushes to `origin` as the checkout is configured. The local tag is written after the
// push, so later steps of the same job read it.
//
// Usage: node scripts/release-tag.mjs <tag> [<sha>]      (sha defaults to HEAD)

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT } from "./version-line.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The remote and the environment a tag push uses. The token travels as an
 *  environment-borne header, never in argv or a URL a git message could print. */
function pushTarget() {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return { remote: "origin", env: process.env };
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    remote: `https://github.com/${repository}.git`,
    env: {
      ...process.env,
      // The first entry clears the checkout's own header, the second sets the token's.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
    },
  };
}

/** Pushes `tag` at `sha` and writes it locally. */
export function pushTag(tag, sha, cwd = ROOT) {
  const { remote, env } = pushTarget();
  execFileSync("git", ["push", "--quiet", remote, `${sha}:refs/tags/${tag}`], { cwd, env, stdio: "inherit" });
  git(cwd, "update-ref", `refs/tags/${tag}`, sha);
}

/** `created` or `exists`. `create(tag, sha)` makes the tag on the remote. */
export function ensureTag({ cwd = ROOT, tag, sha, create = (name, at) => pushTag(name, at, cwd) }) {
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
    const [tag, given = "HEAD"] = process.argv.slice(2);
    if (!tag) throw new Error("usage: release-tag.mjs <tag> [<sha>]");
    const sha = git(ROOT, "rev-parse", "--verify", `${given}^{commit}`);
    console.log(`release-tag: ${tag} ${ensureTag({ tag, sha })} at ${sha}.`);
  } catch (error) {
    console.error(`::error::release-tag: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
