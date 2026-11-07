#!/usr/bin/env node
// Attaches files to the GitHub Release of a tag — draft or published, as it stands.
//
// The Publish run creates the release as a draft and the standalone CLI's job
// publishes it, so the jobs that add a `.vsix`, a Studio build or the docs site
// find it in either state. A file whose name the release already holds is replaced
// (a re-run attaches the same names). The release is never created here: one that
// does not exist means the run's `release` job did not make it, and that is refused.
//
// Usage: node scripts/release-assets.mjs <tag> <file>...      env GITHUB_TOKEN, GITHUB_REPOSITORY

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Attach `files` (`{ name, bytes }`) to the release at `tag`. `api(method, url,
 * body?, headers?)` returns `{ status, json() }`; `url` is repo-relative
 * (`/releases`) or an absolute upload URL.
 */
export async function attachAssets({ tag, files, api }) {
  let release;
  for (let page = 1; !release; page++) {
    const listed = await (await api("GET", `/releases?per_page=100&page=${page}`)).json();
    if (listed.length === 0) break;
    release = listed.find((candidate) => candidate.tag_name === tag);
  }
  if (!release) throw new Error(`No release for ${tag}: the Publish run's release job creates it before assets are attached.`);

  for (const { name, bytes } of files) {
    for (const held of release.assets.filter((asset) => asset.name === name)) {
      await api("DELETE", `/releases/assets/${held.id}`);
    }
    const uploaded = await api(
      "POST",
      `https://uploads.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      bytes,
      { "content-type": "application/octet-stream" },
    );
    if (uploaded.status >= 300) throw new Error(`Uploading ${name} to ${tag} failed: ${uploaded.status} ${await uploaded.text()}`);
    console.log(`release-assets: ${name} -> ${tag}`);
  }
}

async function main() {
  const [tag, ...paths] = process.argv.slice(2);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = process.env;
  if (!tag || paths.length === 0 || !token || !repository) {
    throw new Error("usage: release-assets.mjs <tag> <file>... (env GITHUB_TOKEN, GITHUB_REPOSITORY)");
  }
  const api = async (method, url, body, headers = {}) => {
    const response = await fetch(url.startsWith("http") ? url : `https://api.github.com/repos/${repository}${url}`, {
      method,
      body,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...headers },
    });
    if (!response.ok && method !== "POST") throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
    return response;
  };
  await attachAssets({ tag, files: paths.map((path) => ({ name: basename(path), bytes: readFileSync(path) })), api });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::release-assets: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
