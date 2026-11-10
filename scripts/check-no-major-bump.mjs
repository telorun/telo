#!/usr/bin/env node
// Fail if any @telorun/* workspace package.json, or any workspace module's
// `metadata.version`, is >= 1.0.0.
//
// Telo is pre-1.0 RC. A bump into 1.x is almost always a peer-dep cascade or
// linked-group mishap (the umbrella reset history in `scripts/lib/umbrella-
// targets.mjs` exists because this happened twice). The guard runs on the
// release PR (`changeset-release/*`) so the mistake gets caught before the PR is
// merged and triggers an autopublish.
//
// Modules are those `telo-workspace.yaml` names under `release.modules` (a trailing `*`
// lists a directory); their versions live in the manifest, not in any package.json.
//
// Usage:
//   node scripts/check-no-major-bump.mjs

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".telo",
  ".git",
  ".claude",
  ".pnpm",
  "tmp",
]);

function walk(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, results);
    else if (entry === "package.json") results.push(full);
  }
  return results;
}

const offenders = [];
for (const f of walk(ROOT)) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    continue;
  }
  if (!pkg.name?.startsWith("@telorun/")) continue;
  if (pkg.private) continue; // skip workspace-root + other private packages
  if (typeof pkg.version !== "string") continue;
  const major = parseInt(pkg.version.split(".")[0], 10);
  if (Number.isFinite(major) && major >= 1) {
    offenders.push({
      name: pkg.name,
      version: pkg.version,
      path: f.slice(ROOT.length + 1),
    });
  }
}

// metadata.version of a manifest's first document; null when it declares none.
function manifestVersion(file) {
  const text = readFileSync(file, "utf8");
  const docEnd = text.search(/^---\s*$/m);
  const meta = (docEnd === -1 ? text : text.slice(0, docEnd)).match(/^metadata:\s*\n((?:[ \t]+.*\n?)+)/m);
  return meta?.[1].match(/^[ \t]+version:[ \t]*["']?(\d+\.\d+\.\d+[^"'\s]*)["']?[ \t]*(?:#.*)?$/m)?.[1] ?? null;
}

function moduleDirs() {
  const workspace = join(ROOT, "telo-workspace.yaml");
  if (!existsSync(workspace)) return [];
  const entries = parse(readFileSync(workspace, "utf8"))?.release?.modules ?? [];
  return entries.flatMap((entry) => {
    const pattern = typeof entry === "string" ? entry : entry.path;
    if (!pattern.endsWith("/*")) return [pattern];
    const base = join(ROOT, pattern.slice(0, -2));
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .filter((name) => statSync(join(base, name)).isDirectory())
      .map((name) => `${pattern.slice(0, -2)}/${name}`);
  });
}

const moduleOffenders = [];
for (const dir of moduleDirs()) {
  const manifest = join(ROOT, dir, "telo.yaml");
  if (!existsSync(manifest)) continue;
  const version = manifestVersion(manifest);
  if (version && parseInt(version.split(".")[0], 10) >= 1) moduleOffenders.push({ dir, version });
}

if (moduleOffenders.length) {
  console.error("Telo is pre-1.0; the following workspace modules are at metadata.version >= 1.0.0:");
  console.error("");
  for (const o of moduleOffenders) console.error(`  ${o.dir}@${o.version}  (${o.dir}/telo.yaml)`);
  console.error("");
  console.error("Breaking module changes ship as an Added fragment, a minor bump. Review the");
  console.error("fragments this release applied.");
  if (!offenders.length) process.exit(1);
  console.error("");
}

if (offenders.length) {
  console.error("Telo is pre-1.0; the following workspace packages are at version >= 1.0.0:");
  console.error("");
  for (const o of offenders) {
    console.error(`  ${o.name}@${o.version}  (${o.path})`);
  }
  console.error("");
  console.error("This is almost always a peer-dep cascade or linked-group misbump.");
  console.error("Review the changesets in this PR. If the bump is intentional, this guard");
  console.error("can be removed in a follow-up — but right now you're about to repeat the");
  console.error("0.x → 1.0.0 disaster.");
  process.exit(1);
}

console.log("ok — all @telorun/* packages and workspace modules remain pre-1.0");
