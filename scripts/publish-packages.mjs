#!/usr/bin/env node
// Run by `changesets/action` as the `publish` script after the Version PR merges.
// 1. `changeset publish` — publishes npm packages whose versions moved and pushes git tags.
// 2. For each modules/<name>/telo.yaml that changed vs HEAD^, push it to the Telo registry
//    via `telo publish --skip-controllers` (controllers were already built/published and
//    PURLs synced by version-packages.mjs; this step only runs static analysis and PUTs the
//    manifest to the registry).
//
// Usage: node scripts/publish-packages.mjs
// Env: TELO_REGISTRY (default: https://registry.telo.run)

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const registry = process.env.TELO_REGISTRY ?? "https://registry.telo.run";

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: ROOT }).trim();
}

function runLive(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

function packageVersionAt(ref, pkgPath) {
  try {
    const text = run(`git show ${ref}:${pkgPath}`);
    return JSON.parse(text).version ?? null;
  } catch {
    return null;
  }
}

runLive("pnpm changeset publish");

// Only push manifests whose matching @telorun/<name> package.json version actually moved
// in HEAD^..HEAD. This gates registry pushes to real release commits — a non-release main
// push that happens to touch a telo.yaml (typo fix, schema edit) won't trigger a republish
// of an unchanged version.
let diff;
try {
  diff = run("git diff --name-only HEAD^ HEAD");
} catch {
  console.log("No prior commit to diff against — skipping Telo registry push.");
  process.exit(0);
}

const changedYamls = diff
  .split("\n")
  .filter((f) => /^modules\/[^/]+\/telo\.yaml$/.test(f));

const manifests = [];
for (const f of changedYamls) {
  const name = f.split("/")[1];
  const pkgPath = `modules/${name}/nodejs/package.json`;
  const before = packageVersionAt("HEAD^", pkgPath);
  const after = packageVersionAt("HEAD", pkgPath);
  if (!before || !after || before === after) {
    console.log(`  skip ${f}: @telorun/${name} version unchanged (${before ?? "n/a"})`);
    continue;
  }
  const abs = join(ROOT, f);
  if (existsSync(abs)) manifests.push(abs);
}

if (manifests.length === 0) {
  console.log("No module manifests with a version bump in this commit — nothing to push.");
  process.exit(0);
}

console.log(`\nPushing ${manifests.length} module manifest(s) to ${registry}:`);
for (const m of manifests) console.log(`  ${m.replace(ROOT + "/", "")}`);
console.log("");

for (const m of manifests) {
  runLive(
    `node ./cli/nodejs/bin/telo.mjs publish --skip-controllers --registry=${registry} ${m}`,
  );
}
