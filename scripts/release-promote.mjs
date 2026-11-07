#!/usr/bin/env node
// Publishes the draft GitHub Release of a Publish run, once its assets are attached.
//
// A candidate is published as a pre-release and never `latest`; a final or patch is
// `latest` unless the repo's current latest release is a higher version, so
// re-running an old publish moves nothing. The flags are sent with the publish
// itself: left out, GitHub chooses `latest` by its own rule.
//
// Usage: node scripts/release-promote.mjs <tag>      env GITHUB_TOKEN, GITHUB_REPOSITORY

import { pathToFileURL } from "node:url";
import { channelOf, githubReleaseFlags } from "./release-channel.mjs";

/** The PATCH body that publishes the release of `tag`. */
export function promotion({ tag, latestTag }) {
  const version = tag.replace(/^v/, "");
  const flags = githubReleaseFlags({ channel: channelOf({ cliVersion: version }), version, latestTag });
  return { draft: false, prerelease: flags.prerelease, make_latest: flags.makeLatest };
}

async function main() {
  const [tag] = process.argv.slice(2);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = process.env;
  if (!tag || !token || !repository) throw new Error("usage: release-promote.mjs <tag> (env GITHUB_TOKEN, GITHUB_REPOSITORY)");
  const api = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...init.headers },
    });
    if (!response.ok && response.status !== 404) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
    return response;
  };

  // The tag lookup does not return a draft, so the release is found in the list.
  let release;
  for (let page = 1; !release; page++) {
    const releases = await (await api(`/releases?per_page=100&page=${page}`)).json();
    if (releases.length === 0) break;
    release = releases.find((candidate) => candidate.tag_name === tag);
  }
  if (!release) throw new Error(`No release found for ${tag}.`);

  const latest = await api("/releases/latest");
  const body = promotion({ tag, latestTag: latest.ok ? (await latest.json()).tag_name : undefined });
  await api(`/releases/${release.id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  console.log(`release-promote: published ${tag} (prerelease: ${body.prerelease}, latest: ${body.make_latest}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::release-promote: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
