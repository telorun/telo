#!/usr/bin/env node
// Run by `changesets/action` as the `publish` script after the Version PR merges.
// 1. `changeset publish` — publishes npm packages whose versions moved and pushes git tags.
// 2. For each modules/<name>/telo.yaml whose own metadata.version moved vs HEAD^, push it to
//    the Telo registry via `telo publish --skip-controllers` (controllers were already
//    built/published and PURLs synced by version-packages.mjs; this step only runs static
//    analysis and PUTs the manifest to the registry). The gate is the manifest's own
//    metadata.version and nothing else — manifest-only modules (no controllers, no
//    nodejs/package.json) publish on exactly the same footing as controller modules.
//
// Usage: node scripts/publish-packages.mjs
// Env: TELO_REGISTRY (default: https://registry.telo.run)

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

// metadata.version of the first YAML document, read from the file's content at a git ref.
// Scoped to everything before the first `---` and to the `metadata:` block so a nested
// Telo.Definition field named `version` can't match. Returns null when the file is absent at
// that ref (newly added module) or declares no metadata.version.
function manifestVersionAt(ref, yamlPath) {
  let content;
  try {
    content = run(`git show ${ref}:${yamlPath}`);
  } catch {
    return null;
  }
  const docEnd = content.search(/^---\s*$/m);
  const firstDoc = docEnd === -1 ? content : content.slice(0, docEnd);
  const metaMatch = firstDoc.match(/^metadata:\s*\n((?:[ \t]+.*\n?)+)/m);
  if (!metaMatch) return null;
  const versionMatch = metaMatch[1].match(/^[ \t]+version:[ \t]*["']?(\d+\.\d+\.\d+)["']?[ \t]*$/m);
  return versionMatch ? versionMatch[1] : null;
}

// Sibling module names an `imports:` entry of the first YAML document points at with a
// relative source (`../<name>`, bare or object `source:` form). `telo publish` canonicalizes
// those to registry refs and verifies each resolves at its published location, so a sibling
// bumped in the same release must be pushed first.
function relativeImportDeps(yamlPath) {
  const content = readFileSync(yamlPath, "utf8");
  const docEnd = content.search(/^---\s*$/m);
  const firstDoc = docEnd === -1 ? content : content.slice(0, docEnd);
  const block = firstDoc.match(/^imports:\s*\n((?:(?:[ \t]+.*)?\n)+)/m);
  if (!block) return [];
  const deps = new Set();
  for (const line of block[1].split("\n")) {
    const source = line.match(/:[ \t]*["']?(\.\.?\/[^"'#\s]+)/);
    if (source) deps.add(basename(source[1].replace(/\/telo\.yaml$/, "").replace(/\/+$/, "")));
  }
  return [...deps];
}

// Depth-first topological order over the batch's relative imports, so a dependency is pushed
// before its dependents. Ties and cycle members keep their incoming (alphabetical) order.
function orderByDependencies(paths) {
  const byName = new Map(paths.map((p) => [basename(dirname(p)), p]));
  const ordered = [];
  const state = new Map();
  const visit = (name) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      console.warn(`  warning: import cycle through module '${name}' — publish order may be wrong`);
      return;
    }
    state.set(name, "visiting");
    for (const dep of relativeImportDeps(byName.get(name))) {
      if (byName.has(dep)) visit(dep);
    }
    state.set(name, "done");
    ordered.push(byName.get(name));
  };
  for (const name of byName.keys()) visit(name);
  return ordered;
}

runLive("pnpm changeset publish");

// Only push manifests whose own metadata.version actually moved in HEAD^..HEAD. This gates
// registry pushes to real release commits — a non-release main push that happens to touch a
// telo.yaml (typo fix, schema edit) won't trigger a republish of an unchanged version. A
// newly added module (absent at HEAD^) publishes on its first commit.
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
  const before = manifestVersionAt("HEAD^", f);
  const after = manifestVersionAt("HEAD", f);
  if (!after) {
    console.log(`  skip ${f}: no metadata.version`);
    continue;
  }
  if (before === after) {
    console.log(`  skip ${f}: metadata.version unchanged (${after})`);
    continue;
  }
  const abs = join(ROOT, f);
  if (existsSync(abs)) manifests.push(abs);
}

if (manifests.length === 0) {
  console.log("No module manifests with a version bump in this commit — nothing to push.");
  process.exit(0);
}

const publishOrder = orderByDependencies(manifests);

console.log(`\nPushing ${publishOrder.length} module manifest(s) to ${registry}:`);
for (const m of publishOrder) console.log(`  ${m.replace(ROOT + "/", "")}`);
console.log("");

const failures = [];
for (const m of publishOrder) {
  const rel = m.replace(ROOT + "/", "");
  try {
    runLive(
      `node ./cli/nodejs/bin/telo.mjs publish --skip-controllers --registry=${registry} ${m}`,
    );
  } catch (err) {
    // Don't let one module's push abort the rest of the release. Pushes are
    // idempotent PUTs, but the gate on HEAD^..HEAD means a manifest skipped
    // here won't be retried until its npm version moves again — so the loop
    // must give every changed manifest a shot before exiting non-zero.
    failures.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
    console.error(`\n  push failed for ${rel} — continuing with remaining manifests.`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} manifest push(es) failed:`);
  for (const f of failures) {
    console.error(`  ${f.path}`);
    if (f.message) console.error(`    ${f.message.split("\n")[0]}`);
  }
  process.exit(1);
}
