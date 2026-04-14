#!/usr/bin/env node
// Detects changed Telo modules via git and publishes each via `telo publish`.
// Bump level is read from changeset files ("namespace/name": minor) or defaults to patch.
//
// Usage: node scripts/release-modules.mjs [patch|minor|major]
//   patch  (default) — used when no changeset entry exists for a module

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const defaultBump = ["patch", "minor", "major"].find((b) => args.includes(b)) ?? "patch";
const registry = process.env.TELO_REGISTRY ?? "https://registry.telo.run";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: ROOT }).trim();
}

function runLive(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

// ---------------------------------------------------------------------------
// Guard: require clean working tree
// ---------------------------------------------------------------------------
const dirty = run("git status --porcelain");
if (dirty) {
  console.error("Error: working tree has uncommitted changes. Commit or stash first.\n");
  console.error(dirty);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read module bump levels from changeset files
// Keys like "std/run": minor are module changesets (contain a slash, no @)
// ---------------------------------------------------------------------------
function readModuleChangesets() {
  const changesetDir = join(ROOT, ".changeset");
  const bumps = {}; // "namespace/name" → "patch"|"minor"|"major"
  let files;
  try {
    files = readdirSync(changesetDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return bumps;
  }
  for (const file of files) {
    const text = readFileSync(join(changesetDir, file), "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    for (const line of match[1].split("\n")) {
      const m = line.match(/^"([^"@]+\/[^"@]+)":\s*(patch|minor|major)$/);
      if (m) bumps[m[1]] = m[2];
    }
  }
  return bumps;
}

const moduleBumps = readModuleChangesets();

// ---------------------------------------------------------------------------
// Find base reference (last changeset tag or initial commit)
// ---------------------------------------------------------------------------
let base;
try {
  const allTags = run("git for-each-ref --sort=-creatordate --format='%(refname:short)' refs/tags")
    .split("\n")
    .filter(Boolean);
  const lastTag = allTags.find((t) => t.slice(1).includes("@"));
  base = lastTag ?? run("git rev-list --max-parents=0 HEAD");
} catch {
  base = run("git rev-list --max-parents=0 HEAD");
}

console.log(`\nBase: ${base}`);

// ---------------------------------------------------------------------------
// Detect changed modules
// ---------------------------------------------------------------------------
const changedFiles = run(`git diff --name-only "${base}"..HEAD`).split("\n").filter(Boolean);

const modulePackageDirs = readdirSync(join(ROOT, "modules"))
  .map((m) => join(ROOT, "modules", m, "nodejs"))
  .filter((d) => existsSync(d));

const changedManifests = new Set();

for (const file of changedFiles) {
  const abs = resolve(ROOT, file);
  for (const modDir of modulePackageDirs) {
    const manifestDir = resolve(modDir, "..");
    const manifestFile = join(manifestDir, "telo.yaml");
    if (!existsSync(manifestFile)) continue;
    if (abs.startsWith(manifestDir + "/")) {
      changedManifests.add(manifestFile);
    }
  }
}

// Also include modules explicitly listed in a changeset file even if no files changed
for (const key of Object.keys(moduleBumps)) {
  const [, name] = key.split("/");
  const manifestFile = join(ROOT, "modules", name, "telo.yaml");
  if (existsSync(manifestFile)) changedManifests.add(manifestFile);
}

// ---------------------------------------------------------------------------
// Resolve bump level per manifest
// ---------------------------------------------------------------------------
function resolveBump(manifestFile) {
  const yaml = readFileSync(manifestFile, "utf8");
  const nsMatch = yaml.match(/^\s{2,4}namespace:\s*(\S+)/m);
  const nameMatch = yaml.match(/^\s{2,4}name:\s*(\S+)/m);
  if (nsMatch && nameMatch) {
    const key = `${nsMatch[1]}/${nameMatch[1]}`;
    if (moduleBumps[key]) return { level: moduleBumps[key], fromChangeset: true };
  }
  return { level: defaultBump, fromChangeset: false };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
if (changedManifests.size === 0) {
  console.log("No changed Telo modules detected.");
  process.exit(0);
}

const plan = [...changedManifests].sort().map((manifest) => {
  const { level, fromChangeset } = resolveBump(manifest);
  return { manifest, level, fromChangeset };
});

console.log(`\nModules to release:`);
for (const { manifest, level, fromChangeset } of plan) {
  const source = fromChangeset ? "changeset" : `default (${defaultBump})`;
  console.log(`  ${manifest.replace(ROOT + "/", "")}  ${level}  [${source}]`);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------
console.log("");
for (const { manifest, level } of plan) {
  runLive(
    `bun ./cli/nodejs/bin/telo.ts publish --registry=${registry} --bump=${level} ${manifest}`,
  );
}

console.log("\nModule release complete!");
