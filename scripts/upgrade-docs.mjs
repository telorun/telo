#!/usr/bin/env node
// Walk every *.md file in the repo and rewrite version pins to the latest
// registry view of each referenced package. Two patterns are matched:
//
//   - std/<name>@<v>       → Telo registry latest (GET /<TELO_REGISTRY>/std/<name>)
//   - @telorun/<name>@<v>  → npm latest          (GET registry.npmjs.org/.../latest)
//
// Skips CHANGELOG.md (historical refs are intentional) and the usual cache
// directories. Manifests (*.yaml, including telo.yaml) are explicitly out of
// scope — use `telo upgrade` for those.
//
// USAGE:
//   node scripts/upgrade-docs.mjs              # dry-run, prints per-file deltas
//   node scripts/upgrade-docs.mjs --yes        # apply rewrites
//
// Any ref whose version differs from the registry's current latest is
// rewritten — including refs that point at versions *higher* than latest
// (which only happens when the doc references an unpublished version).
//
// ENV:
//   TELO_REGISTRY   Telo registry URL (default: https://registry.telo.run)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DRY_RUN = !process.argv.includes("--yes");
const REGISTRY = (process.env.TELO_REGISTRY ?? "https://registry.telo.run").replace(/\/$/, "");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".telo",
  ".git",
  ".pnpm",
  "tmp",
  ".changeset",
  ".github",
]);

const VERSION = String.raw`\d+\.\d+\.\d+(?:[-+][\w.-]*)?`;
const STD_REF = new RegExp(`std/([a-z0-9][a-z0-9-]*)@(${VERSION})`, "g");
const NPM_REF = new RegExp(`@telorun/([a-z0-9][a-z0-9-]*)@(${VERSION})`, "g");

function walkMd(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMd(full, results);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      entry.name !== "CHANGELOG.md"
    ) {
      results.push(full);
    }
  }
  return results;
}

function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareSemver(a, b) {
  const A = parseSemver(a);
  const B = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  }
  // Major/minor/patch tied — fall back to string inequality so refs that
  // differ only in pre-release / build metadata (`0.3.0-alpha.1` vs `0.3.0`)
  // still register as different. Not a full pre-release semver ordering, but
  // enough to mark them stale and trigger a rewrite to the registry's view.
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const npmCache = new Map();
async function npmLatest(name) {
  if (npmCache.has(name)) return npmCache.get(name);
  let v = null;
  try {
    const res = await fetch(
      `https://registry.npmjs.org/@telorun/${encodeURIComponent(name)}/latest`,
    );
    if (res.ok) v = (await res.json()).version ?? null;
  } catch {}
  npmCache.set(name, v);
  return v;
}

const stdCache = new Map();
async function stdLatest(name) {
  if (stdCache.has(name)) return stdCache.get(name);
  let v = null;
  try {
    const res = await fetch(`${REGISTRY}/std/${encodeURIComponent(name)}`);
    if (res.ok) v = (await res.json()).version ?? null;
  } catch {}
  stdCache.set(name, v);
  return v;
}

function lineNumberFor(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log(`mode:          ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
console.log(`telo registry: ${REGISTRY}`);

const files = walkMd(ROOT);
console.log(`scanned:       ${files.length} markdown file(s)\n`);

let filesChanged = 0;
let refsRewritten = 0;
let refsSkipped = 0;

for (const file of files) {
  const original = readFileSync(file, "utf8");
  if (!STD_REF.test(original) && !NPM_REF.test(original)) continue;
  // RegExp lastIndex is sticky for global regexes — reset before reuse.
  STD_REF.lastIndex = 0;
  NPM_REF.lastIndex = 0;

  const matches = [];
  for (const m of original.matchAll(STD_REF)) {
    matches.push({ kind: "std", name: m[1], current: m[2], match: m[0], index: m.index });
  }
  for (const m of original.matchAll(NPM_REF)) {
    matches.push({ kind: "npm", name: m[1], current: m[2], match: m[0], index: m.index });
  }

  // Resolve each unique (kind, name) once via cache.
  const fileUpdates = [];
  for (const ref of matches) {
    const latest = ref.kind === "std" ? await stdLatest(ref.name) : await npmLatest(ref.name);
    if (!latest) {
      refsSkipped++;
      continue;
    }
    // Any non-equal version is stale — older versions are normal upgrades,
    // higher versions are unpublished-and-broken pins. Both get rewritten.
    if (compareSemver(ref.current, latest) !== 0) {
      fileUpdates.push({ ...ref, latest });
    }
  }

  if (!fileUpdates.length) continue;

  console.log(relative(ROOT, file));
  for (const u of fileUpdates) {
    const replacement =
      u.kind === "std" ? `std/${u.name}@${u.latest}` : `@telorun/${u.name}@${u.latest}`;
    console.log(`  ${lineNumberFor(original, u.index)}: ${u.match} → ${replacement}`);
  }
  filesChanged++;
  refsRewritten += fileUpdates.length;

  if (DRY_RUN) continue;

  // Write-time rewrite re-runs the regexes against cached latest values.
  // Refs with no cached value (network failure) pass through unchanged.
  const shouldRewrite = (current, latest) =>
    latest && compareSemver(current, latest) !== 0;
  let updated = original.replace(STD_REF, (full, name, current) => {
    const latest = stdCache.get(name);
    return shouldRewrite(current, latest) ? `std/${name}@${latest}` : full;
  });
  updated = updated.replace(NPM_REF, (full, name, current) => {
    const latest = npmCache.get(name);
    return shouldRewrite(current, latest) ? `@telorun/${name}@${latest}` : full;
  });

  writeFileSync(file, updated);
}

console.log(
  `\nresult: ${filesChanged} file(s) ${DRY_RUN ? "would change" : "changed"}, ` +
    `${refsRewritten} ref(s) ${DRY_RUN ? "would rewrite" : "rewritten"}, ` +
    `${refsSkipped} skipped (registry lookup failed)`,
);
if (DRY_RUN) console.log("\nDry run. Re-run with --yes to apply.");
