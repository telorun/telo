#!/usr/bin/env node
// Batch every changie project that has pending unreleased fragments (auto-bump from the
// fragment kinds), then merge — which rewrites each project's CHANGELOG.md and runs its
// `replacements` rule, writing the new version into modules/<name>/telo.yaml.
//
// changie owns telo module manifest versions; changesets owns the npm controller packages.
// This step runs inside the changesets version step (scripts/version-packages.mjs) so module
// bumps ride in the same Version PR, and standalone in the module-only fallback CI job.
// See plans/changesets-to-changie.md.
//
// Usage: node scripts/changie-release.mjs   (or import { releaseChangieProjects })
// Env: CHANGIE_BIN overrides the `changie` binary path (default: `changie` on PATH).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UNRELEASED_DIR = join(ROOT, ".changes", "unreleased");
const CHANGIE = process.env.CHANGIE_BIN ?? "changie";

function changie(args) {
  execFileSync(CHANGIE, args, { cwd: ROOT, stdio: "inherit" });
}

/** Distinct `project:` keys across all pending fragment files. */
function pendingProjects() {
  if (!existsSync(UNRELEASED_DIR)) return [];
  const projects = new Set();
  for (const file of readdirSync(UNRELEASED_DIR)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const text = readFileSync(join(UNRELEASED_DIR, file), "utf8");
    const key = text.match(/^project:[ \t]*["']?([^\s"']+)/m)?.[1];
    if (key) projects.add(key);
  }
  return [...projects].sort();
}

export function releaseChangieProjects() {
  const projects = pendingProjects();
  if (projects.length === 0) {
    console.log("changie-release: no pending module fragments — nothing to batch.");
    return [];
  }
  console.log(`changie-release: batching ${projects.length} project(s): ${projects.join(", ")}`);
  for (const key of projects) changie(["batch", "auto", "-j", key]);
  // merge has no per-project flag: it rewrites every project's changelog from its version
  // files and runs all replacements. Only the batched projects' telo.yaml versions actually
  // move; the rest re-render to identical content.
  changie(["merge"]);
  return projects;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  releaseChangieProjects();
}
