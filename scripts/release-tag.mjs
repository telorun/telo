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
// `--units` tags each release unit the release commit moved, `<unit key>@<version>`
// — the names `telo release tag` gives, read with the release commit checked out
// (it compares that commit's ledger with its parent's) — on the release commit
// itself, so the links a packed package names exist before anything publishes.
//
// Usage: node scripts/release-tag.mjs <tag> [<sha>]      (sha defaults to HEAD)
//        node scripts/release-tag.mjs --units            (HEAD is the release commit)

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT } from "./version-line.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The remote and the environment a tag push uses. The token travels as an
 *  environment-borne header, never in argv or a URL a git message could print. */
export function pushTarget() {
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

/** The unit tags `telo release tag` names for HEAD, from the workspace CLI. */
export function unitTags(cwd = ROOT) {
  const out = execFileSync(process.execPath, ["./cli/nodejs/bin/telo.mjs", "release", "tag", "--dry-run", "-o", "json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out).tags;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    if (process.argv[2] === "--units") {
      const sha = git(ROOT, "rev-parse", "HEAD");
      const tags = unitTags();
      for (const tag of tags) console.log(`release-tag: ${tag} ${ensureTag({ tag, sha })} at ${sha}.`);
      if (tags.length === 0) console.log("release-tag: the release commit moved no unit.");
      process.exit(0);
    }
    const [tag, given = "HEAD"] = process.argv.slice(2);
    if (!tag) throw new Error("usage: release-tag.mjs <tag> [<sha>]");
    const sha = git(ROOT, "rev-parse", "--verify", `${given}^{commit}`);
    console.log(`release-tag: ${tag} ${ensureTag({ tag, sha })} at ${sha}.`);
  } catch (error) {
    console.error(`::error::release-tag: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
