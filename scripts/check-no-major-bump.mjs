#!/usr/bin/env node
// Fail if any @telorun/* workspace package.json has version >= 1.0.0.
//
// Telo is pre-1.0 RC. A bump into 1.x is almost always a peer-dep cascade or
// linked-group mishap (the umbrella reset history in `scripts/lib/umbrella-
// targets.mjs` exists because this happened twice). The guard runs on the
// changesets Version PR (`changeset-release/main`) so the mistake gets caught
// before the PR is merged and triggers an autopublish.
//
// Usage:
//   node scripts/check-no-major-bump.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".telo",
  ".git",
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

console.log("ok — all @telorun/* packages remain pre-1.0");
