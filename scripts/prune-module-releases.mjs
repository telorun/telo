#!/usr/bin/env node
// Deletes GitHub Releases that are really MODULE releases.
//
// Until `scripts/github-releases.mjs` took over, `changesets/action` created a
// release for every package `changeset publish` published — module-owned packages
// included, since their versions are moved by `telo release apply` and the action
// has no filter. Modules are released as OCI artifacts and discovered through the
// hub; their changelog lives in the module directory. They have no releases here.
//
// Classification is by MODULE DIRECTORY, not by current package name, because the
// naming changed: before controllers were bundled, every module published
// `@telorun/<module>`; now it is a private `@telorun/<module>-build`. Both eras
// resolve through `modules/<module>/`.
//
// Three buckets, and the third is why this asks before acting:
//
//   keep     a published, non-module workspace package, or a `vscode-v*` release
//   module   `modules/<name>/` exists in this repo — a module release
//   unknown  neither: a retired module (`sql-sqlite`), or a package that moved to
//            another repo (`s3`, `lambda`). NOT deleted unless --include-unknown.
//
// A deleted release leaves its git tag alone. The tag records an npm publication
// and costs nothing; the release page is what was noisy.
//
// Usage:
//   node scripts/prune-module-releases.mjs                     # print the plan
//   GITHUB_TOKEN=… node scripts/prune-module-releases.mjs --yes
//   GITHUB_TOKEN=… node scripts/prune-module-releases.mjs --yes --include-unknown

import { loadWorkspace, moduleDirectoryFor } from "./module-ownership.mjs";

const apply = process.argv.includes("--yes");
const includeUnknown = process.argv.includes("--include-unknown");
const repository = process.env.GITHUB_REPOSITORY ?? "telorun/telo";
const token = process.env.GITHUB_TOKEN;

if (apply && !token) {
  console.error("prune-module-releases: --yes needs GITHUB_TOKEN with contents: write.");
  process.exit(1);
}

async function listReleases() {
  const releases = [];
  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Listing releases failed: ${response.status} ${await response.text()}`);
    }
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

const { releasing } = loadWorkspace();

// ORDER IS THE SAFETY PROPERTY. A package the workspace publishes today is judged
// `keep` before any directory is consulted, so a releasing package can never be
// deleted because a module directory happens to share its name. Only a name the
// workspace no longer holds reaches `moduleDirectoryFor`, which additionally
// requires a `telo.yaml` — "a module lives here", not "a directory shares this name".
function classify(tag) {
  const match = /^(@telorun\/[a-z0-9][a-z0-9-]*)@(.+)$/.exec(tag);
  if (!match) return "keep"; // vscode-v*, and anything else not a package tag.
  const [, name] = match;
  if (releasing.has(name)) return "keep";
  if (moduleDirectoryFor(name)) return "module";
  return "unknown";
}

const buckets = { keep: [], module: [], unknown: [] };
for (const release of await listReleases()) {
  buckets[classify(release.tag_name)].push(release);
}

const byPackage = (list) => {
  const counts = new Map();
  for (const r of list) {
    const name = r.tag_name.replace(/@[^@]*$/, "");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
};

console.log(`keep:    ${buckets.keep.length}`);
console.log(`module:  ${buckets.module.length}   (deleted)`);
for (const [name, count] of byPackage(buckets.module)) console.log(`           ${count}  ${name}`);
console.log(
  `unknown: ${buckets.unknown.length}   (${includeUnknown ? "deleted" : "kept — pass --include-unknown to delete"})`,
);
for (const [name, count] of byPackage(buckets.unknown)) console.log(`           ${count}  ${name}`);

const doomed = [...buckets.module, ...(includeUnknown ? buckets.unknown : [])];

if (!apply) {
  console.log(`\nDry run. ${doomed.length} releases would be deleted; pass --yes to delete them.`);
  process.exit(0);
}

let deleted = 0;
for (const release of doomed) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/${release.id}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Deleting ${release.tag_name} failed: ${response.status} ${await response.text()}`,
    );
  }
  deleted += 1;
  if (deleted % 25 === 0) console.log(`  … ${deleted}/${doomed.length}`);
}
console.log(`Deleted ${deleted} releases. Their git tags are untouched.`);
