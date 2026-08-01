#!/usr/bin/env node
// Run by `changesets/action` in the "Version Packages" step.
// Wraps `changeset version` and extends it for Telo modules:
//   - records each module's npm controller version BEFORE the bump
//   - runs `changeset version` (bumps workspace package.json files, writes npm CHANGELOGs)
//   - for each modules/<name>/nodejs/package.json whose version changed, rewrites the
//     pkg:npm PURL in modules/<name>/telo.yaml to match
//   - runs changie (batch + merge) so module manifest versions + CHANGELOGs are updated in
//     the SAME Version PR as the npm bumps.
//
// PURL-sync applies to the modules that still deliver their controller from npm.
// Without it a controller bump leaves the manifest pinned to the previous version,
// so the module publishes new and loads old — a case no author can see. It matches
// nothing in a bundled manifest, so it retires itself as the remaining npm-backed
// modules migrate.
//
// It does NOT queue a changie fragment. That step used to answer "did this
// module's shipped bytes change?" by proxy — from whether its npm package version
// moved — which misses a lockfile-only bump and fires on a version move that
// changed no emitted byte. `telo publish` now answers the same question from the
// bytes themselves, comparing each built layer's `integrity` against the published
// artifact's `layers:` index (see cli/nodejs/src/bundle/payload-drift.ts), so the
// inference has nothing left to add.
//
// changie owns telo module manifest versions (metadata.version, published to the telo
// registry); changesets owns the npm controller packages. See plans/changesets-to-changie.md.
//
// Usage: node scripts/version-packages.mjs
// Env: CHANGIE_BIN overrides the `changie` binary path (passed through to changie-release).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseChangieProjects } from "./changie-release.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function runLive(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

function readPkgVersion(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function diffLevel(before, after) {
  if (!before || !after || before === after) return null;
  const a = before.split(".").map(Number);
  const b = after.split(".").map(Number);
  if (b[0] > a[0]) return "major";
  if (b[1] > a[1]) return "minor";
  if (b[2] > a[2]) return "patch";
  return null;
}

function rewritePurls(content, packageName, newVersion) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`(pkg:[^/]+/${escaped}@)[^?#\\s]+(\\?[^#\\s]*)?(#[^\\s]*)?`, "g"),
    (_, prefix, qs, frag) => `${prefix}${newVersion}${qs ?? ""}${frag ?? ""}`,
  );
}

// Snapshot module controller npm versions before changeset consumes the .md files.
const moduleDirs = existsSync(join(ROOT, "modules"))
  ? readdirSync(join(ROOT, "modules"))
      .map((name) => ({ name, pkgPath: join(ROOT, "modules", name, "nodejs", "package.json") }))
      .filter((m) => existsSync(m.pkgPath))
  : [];

const before = new Map();
for (const { name, pkgPath } of moduleDirs) {
  before.set(name, readPkgVersion(pkgPath));
}

// Standard changesets version step (npm packages).
runLive("pnpm changeset version");

// For each module whose npm controller version moved: sync its telo.yaml pkg:npm PURL.
// A bundled module has no pkg:npm PURL to match, so this is a no-op there.
let synced = 0;
for (const { name, pkgPath } of moduleDirs) {
  const after = readPkgVersion(pkgPath);
  if (!diffLevel(before.get(name), after)) continue;

  const manifestPath = join(ROOT, "modules", name, "telo.yaml");
  if (!existsSync(manifestPath)) {
    console.warn(`  ${name}: npm bumped to ${after} but telo.yaml not found — skipping`);
    continue;
  }

  const pkgName = JSON.parse(readFileSync(pkgPath, "utf8")).name;
  const content = readFileSync(manifestPath, "utf8");
  const rewritten = rewritePurls(content, pkgName, after);
  if (rewritten === content) continue;
  writeFileSync(manifestPath, rewritten);
  synced++;
  console.log(`  ${name}: PURL ${pkgName}@* → @${after}`);
}

console.log(`\nversion-packages: synced ${synced} module manifest(s) to their npm controller.`);

// Bump module manifest versions + CHANGELOGs from all pending changie fragments (the
// auto-queued ones above plus any hand-written module fragments) in this same Version PR.
releaseChangieProjects();
