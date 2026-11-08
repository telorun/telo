#!/usr/bin/env node
// The docs site as release assets: what a release builds, and what a deploy serves.
//
// Each candidate, final and patch builds the site from its own tag and attaches it
// to its GitHub Release: `site-next.tar.gz` (served under `/next/`) for a candidate,
// `site-root.tar.gz` (served at `/`) for a final or patch. The base URL is fixed at
// build, so the tarball is the site as it is served.
//
// A deploy composes the newest final's root with, while a candidate of a LATER
// release is open, that candidate's next. Earlier releases are not served, and
// re-running an old candidate's publish after its final shipped serves no `/next/`.
//
// Usage:
//   node scripts/release-site.mjs build --tag v0.85.0-rc.1
//       outputs: channel, version, asset, base-url, preview
//   node scripts/release-site.mjs compose --channel C --version V --out DIR
//       [--own-root FILE] [--own-next FILE]     env GH_TOKEN, GITHUB_REPOSITORY
//       extracts the site into DIR; outputs: next

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { channelOf } from "./release-channel.mjs";
import { compareVersions, releaseTriple } from "./version-line.mjs";

export const ROOT_ASSET = "site-root.tar.gz";
export const NEXT_ASSET = "site-next.tar.gz";

/** How to build the site for the release at `tag` (`v<version>`). */
export function siteBuild({ tag }) {
  const version = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || tag === version) {
    throw new Error(`'${tag}' is not a release tag (v<major>.<minor>.<patch>[-rc.N]).`);
  }
  const channel = channelOf({ cliVersion: version });
  return channel === "candidate"
    ? { channel, version, asset: NEXT_ASSET, baseUrl: "/next/", preview: releaseTriple(version) }
    : { channel, version, asset: ROOT_ASSET, baseUrl: "/", preview: "" };
}

/**
 * What a deploy serves. `releases` are GitHub releases (`tag_name`, `draft`,
 * `prerelease`, `assets: [{ name }]`). Returns `{ root, next }`: `root` is
 * `{ own: true }` (this run's tarball) or `{ tag }` (the newest published final's
 * asset), `next` whether this run's candidate is served under `/next/`.
 */
export function composePlan({ channel, version, releases }) {
  const finals = releases
    .filter((release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  const newest = finals[0];

  if (channel === "candidate") {
    if (!newest) {
      throw new Error(
        `No published final release to serve at '/'. Attach ${ROOT_ASSET} to the newest final by dispatching the site build at its tag (RELEASING.md, "The first cut").`,
      );
    }
    if (!(newest.assets ?? []).some((asset) => asset.name === ROOT_ASSET)) {
      throw new Error(`${newest.tag_name} has no ${ROOT_ASSET}. Dispatch the site build at ${newest.tag_name} to attach it.`);
    }
    return { root: { tag: newest.tag_name }, next: compareVersions(releaseTriple(version), newest.tag_name.slice(1)) > 0 };
  }

  if (!newest || compareVersions(version, newest.tag_name.slice(1)) >= 0) return { root: { own: true }, next: false };
  if (!(newest.assets ?? []).some((asset) => asset.name === ROOT_ASSET)) {
    throw new Error(`${newest.tag_name} has no ${ROOT_ASSET}. Dispatch the site build at ${newest.tag_name} to attach it.`);
  }
  return { root: { tag: newest.tag_name }, next: false };
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function compose(args) {
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const [channel, version, out] = [flag("--channel"), flag("--version"), flag("--out")];
  if (!channel || !version || !out) throw new Error("usage: compose --channel C --version V --out DIR [--own-root FILE] [--own-next FILE]");
  const repository = process.env.GITHUB_REPOSITORY;
  const releases = JSON.parse(
    execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }),
  ).flat();
  const plan = composePlan({ channel, version, releases });

  mkdirSync(join(out, "next"), { recursive: true });
  let rootFile = flag("--own-root");
  if (plan.root.own) {
    if (!rootFile) throw new Error(`This run's ${ROOT_ASSET} is the site root, but --own-root was not given.`);
  } else {
    const downloads = join(out, ".download");
    run("gh", ["release", "download", plan.root.tag, "--repo", repository, "--pattern", ROOT_ASSET, "--dir", downloads, "--clobber"]);
    rootFile = join(downloads, ROOT_ASSET);
  }
  run("tar", ["-xzf", rootFile, "-C", out]);
  if (plan.next) {
    const nextFile = flag("--own-next");
    if (!nextFile) throw new Error(`This run's ${NEXT_ASSET} is the preview, but --own-next was not given.`);
    run("tar", ["-xzf", nextFile, "-C", join(out, "next")]);
  } else if (channel === "candidate") {
    console.log(`release-site: ${version} is not newer than the newest final; no /next/ is served.`);
  }
  setOutput("next", plan.next);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "build") {
      const tag = args[args.indexOf("--tag") + 1];
      const build = siteBuild({ tag: tag ?? "" });
      setOutput("channel", build.channel);
      setOutput("version", build.version);
      setOutput("asset", build.asset);
      setOutput("base-url", build.baseUrl);
      setOutput("preview", build.preview);
    } else if (command === "compose") {
      compose(args);
    } else {
      throw new Error(`unknown command '${command ?? ""}'.`);
    }
  } catch (error) {
    console.error(`::error::release-site: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
