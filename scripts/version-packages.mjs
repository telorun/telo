#!/usr/bin/env node
// Run by `changesets/action` in the "Version Packages" step.
// Wraps `changeset version` and extends it for Telo modules:
//   - records per-module npm versions BEFORE the bump
//   - runs `changeset version` (bumps workspace package.json files, writes CHANGELOGs)
//   - for each modules/<name>/nodejs/package.json whose version changed (explicit OR cascade),
//     derives the bump level from the semver diff, bumps modules/<name>/telo.yaml's
//     metadata.version by the same level, and rewrites pkg:npm PURLs inside it to match.
//
// Usage: node scripts/version-packages.mjs

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// Bump the `metadata.version` of the first YAML document. Scopes the search to everything
// before the first `---` separator and to the `metadata:` block inside it so a future
// `Telo.Definition.version` or similarly-named field can't accidentally match.
function bumpManifestVersion(content, level) {
  const docEnd = content.search(/^---\s*$/m);
  const firstDoc = docEnd === -1 ? content : content.slice(0, docEnd);

  const metaMatch = firstDoc.match(/^metadata:\s*\n((?:[ \t]+.*\n?)+)/m);
  if (!metaMatch) return null;
  const metaBlock = metaMatch[1];
  const metaStart = metaMatch.index + "metadata:\n".length;

  const versionInMeta = metaBlock.match(
    /^([ \t]+version:[ \t]*)(["']?)(\d+\.\d+\.\d+)\2([ \t]*)$/m,
  );
  if (!versionInMeta) return null;

  const [, prefix, quote, current, trailing] = versionInMeta;
  const parts = current.split(".").map(Number);
  if (level === "major") {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  } else if (level === "minor") {
    parts[1]++;
    parts[2] = 0;
  } else {
    parts[2]++;
  }
  const next = parts.join(".");

  const absStart = metaStart + versionInMeta.index;
  const absEnd = absStart + versionInMeta[0].length;
  const replacement = `${prefix}${quote}${next}${quote}${trailing}`;
  const updated = content.slice(0, absStart) + replacement + content.slice(absEnd);

  return { content: updated, from: current, to: next };
}

function rewritePurls(content, packageName, newVersion) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`(pkg:[^/]+/${escaped}@)[^?#\\s]+(\\?[^#\\s]*)?(#[^\\s]*)?`, "g"),
    (_, prefix, qs, frag) => `${prefix}${newVersion}${qs ?? ""}${frag ?? ""}`,
  );
}

// Snapshot module npm versions before changeset consumes the .md files.
const moduleDirs = existsSync(join(ROOT, "modules"))
  ? readdirSync(join(ROOT, "modules"))
      .map((name) => ({ name, pkgPath: join(ROOT, "modules", name, "nodejs", "package.json") }))
      .filter((m) => existsSync(m.pkgPath))
  : [];

const before = new Map();
for (const { name, pkgPath } of moduleDirs) {
  before.set(name, readPkgVersion(pkgPath));
}

// Standard changesets version step.
runLive("pnpm changeset version");

// Sync each changed module's telo.yaml with the new npm version.
let touched = 0;
for (const { name, pkgPath } of moduleDirs) {
  const after = readPkgVersion(pkgPath);
  const level = diffLevel(before.get(name), after);
  if (!level) continue;

  const manifestPath = join(ROOT, "modules", name, "telo.yaml");
  if (!existsSync(manifestPath)) {
    console.warn(`  ${name}: npm bumped to ${after} but telo.yaml not found — skipping`);
    continue;
  }

  const pkgName = JSON.parse(readFileSync(pkgPath, "utf8")).name;
  let content = readFileSync(manifestPath, "utf8");

  const bumped = bumpManifestVersion(content, level);
  if (!bumped) {
    console.warn(`  ${name}: could not locate metadata.version in ${manifestPath} — skipping`);
    continue;
  }

  content = rewritePurls(bumped.content, pkgName, after);
  writeFileSync(manifestPath, content, "utf8");

  console.log(
    `  ${name}: telo.yaml ${bumped.from} → ${bumped.to}, PURL ${pkgName}@* → @${after}`,
  );
  touched++;
}

console.log(`\nversion-packages: synced ${touched} module manifest(s).`);
