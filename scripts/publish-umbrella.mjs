#!/usr/bin/env node
// Publish the umbrella reset after `npm-unpublish-1x.mjs --yes` has run.
//
// Phases (all idempotent — re-run picks up wherever the previous run stopped):
//   1. Sync workspace state: set each @telorun/* package.json `version` to
//      UMBRELLA_TARGETS[name]; for module packages, also set the matching
//      modules/<name>/telo.yaml `metadata.version` and rewrite the package's
//      own `pkg:npm/@telorun/<name>@<v>` PURLs.
//   2. Auto-commit changes from phase 1 (skip with --no-commit).
//   3. `pnpm changeset publish` — publishes any @telorun/* package whose
//      umbrella version is missing from npm and creates local git tags.
//   4. Push the freshly-created tags to GIT_REMOTE.
//   5. Push every module's telo.yaml to the Telo registry — but only when the
//      umbrella version is not already present there (GET /<ns>/<name>/<v>
//      returns 404).
//
// USAGE:
//   node scripts/publish-umbrella.mjs                    # dry-run
//   node scripts/publish-umbrella.mjs --yes              # execute
//   node scripts/publish-umbrella.mjs --yes --no-commit  # execute, skip auto-commit
//
// ENV:
//   GIT_REMOTE             remote for tag push (default: origin)
//   TELO_REGISTRY          registry URL (default: https://registry.telo.run)
//   TELO_REGISTRY_TOKEN    publish token for the Telo registry (required for
//                          phase 5 in --yes mode; inherited by the CLI subprocess)
//
// PRECONDITIONS:
//   - npm-unpublish-1x.mjs --yes has run cleanly; npm has no @telorun/* >=1.x
//     for packages in UMBRELLA_TARGETS.
//   - UMBRELLA_TARGETS in scripts/lib/umbrella-targets.mjs is correct.
//   - TELO_REGISTRY_TOKEN is exported in the shell running this script.
//
// FAILURE: stops on the first failing phase, exits non-zero. Re-run picks up;
// completed phases are no-ops because they re-derive from observable state.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UMBRELLA_TARGETS } from "./lib/umbrella-targets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DRY_RUN = !process.argv.includes("--yes");
const SKIP_COMMIT = process.argv.includes("--no-commit");
const REMOTE = process.env.GIT_REMOTE ?? "origin";
const REGISTRY = (process.env.TELO_REGISTRY ?? "https://registry.telo.run").replace(/\/$/, "");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".telo",
  ".git",
  ".pnpm",
  "tmp",
]);

function exec(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: ROOT }).trim();
}

function tryExec(cmd) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        encoding: "utf8",
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(),
    };
  } catch (err) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    return { ok: false, err: (stderr || stdout || err.message).trim() };
  }
}

function runLive(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

function walkPkgs(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkPkgs(full, results);
    else if (entry === "package.json") results.push(full);
  }
  return results;
}

// Mirror of version-packages.mjs's metadata-version surgery, but SET to an
// exact value instead of bumping by level. Scoped to the first YAML document
// + the `metadata:` block within it.
function setManifestVersion(content, newVersion) {
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
  if (current === newVersion) return { content, from: current, changed: false };

  const absStart = metaStart + versionInMeta.index;
  const absEnd = absStart + versionInMeta[0].length;
  const replacement = `${prefix}${quote}${newVersion}${quote}${trailing}`;
  const updated = content.slice(0, absStart) + replacement + content.slice(absEnd);
  return { content: updated, from: current, changed: true };
}

function rewritePurls(content, packageName, newVersion) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`(pkg:[^/]+/${escaped}@)[^?#\\s]+(\\?[^#\\s]*)?(#[^\\s]*)?`, "g"),
    (_, prefix, qs, frag) => `${prefix}${newVersion}${qs ?? ""}${frag ?? ""}`,
  );
}

// ─── Index workspace packages ────────────────────────────────────────────────

const pkgFiles = walkPkgs(ROOT);
const pkgByName = new Map();
for (const f of pkgFiles) {
  try {
    const p = JSON.parse(readFileSync(f, "utf8"));
    if (p.name?.startsWith("@telorun/") && !p.private) {
      pkgByName.set(p.name, { path: f, dir: dirname(f), pkg: p });
    }
  } catch {}
}

// Verify every UMBRELLA_TARGETS entry has a matching workspace package.
const missingPackages = [...Object.keys(UMBRELLA_TARGETS)].filter((n) => !pkgByName.has(n));
if (missingPackages.length) {
  console.error(`UMBRELLA_TARGETS lists packages not present in the workspace: ${missingPackages.join(", ")}`);
  process.exit(1);
}

const HAS_REGISTRY_TOKEN = Boolean(process.env.TELO_REGISTRY_TOKEN);

console.log(`mode:       ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
console.log(`git remote: ${REMOTE}`);
console.log(`registry:   ${REGISTRY}`);
console.log(`reg token:  ${HAS_REGISTRY_TOKEN ? "present" : "(unset)"}`);
console.log("");

// Fail fast before any side effects if the token isn't set in live mode.
// Without it, phase 5 would get into the loop and the CLI would 401 on every
// push. Phases 1–4 don't need it, but stopping early avoids partial state
// where commits and npm publishes succeed but the registry stays out of sync.
if (!DRY_RUN && !HAS_REGISTRY_TOKEN) {
  console.error("TELO_REGISTRY_TOKEN is required in --yes mode. Export it and re-run.");
  process.exit(1);
}

// ─── Phase 1: sync workspace versions ────────────────────────────────────────

console.log("Phase 1 — sync workspace versions");
const pkgEdits = [];     // [{ name, path, from, to }]
const manifestEdits = []; // [{ name, manifestPath, from, to }]

for (const [name, target] of Object.entries(UMBRELLA_TARGETS).sort()) {
  const entry = pkgByName.get(name);
  const localVersion = entry.pkg.version;
  if (localVersion !== target) {
    pkgEdits.push({ name, path: entry.path, from: localVersion, to: target });
  }

  // Module packages live at modules/<name>/nodejs/package.json and share their
  // module dir with a sibling telo.yaml at modules/<name>/telo.yaml.
  const modulesDir = join(ROOT, "modules");
  const moduleName = name.replace(/^@telorun\//, "");
  const manifestPath = join(modulesDir, moduleName, "telo.yaml");
  if (!existsSync(manifestPath)) continue;

  const content = readFileSync(manifestPath, "utf8");
  const set = setManifestVersion(content, target);
  if (set && set.changed) {
    manifestEdits.push({ name, manifestPath, from: set.from, to: target });
  }
}

if (!pkgEdits.length && !manifestEdits.length) {
  console.log("  workspace state already at umbrella versions; nothing to write.\n");
} else {
  for (const e of pkgEdits) console.log(`  ${e.name}: package.json ${e.from} → ${e.to}`);
  for (const e of manifestEdits) console.log(`  ${e.name}: telo.yaml ${e.from} → ${e.to} (+ PURLs)`);

  if (!DRY_RUN) {
    for (const e of pkgEdits) {
      const pkg = JSON.parse(readFileSync(e.path, "utf8"));
      pkg.version = e.to;
      writeFileSync(e.path, JSON.stringify(pkg, null, 2) + "\n");
    }
    for (const e of manifestEdits) {
      let content = readFileSync(e.manifestPath, "utf8");
      content = setManifestVersion(content, e.to).content;
      content = rewritePurls(content, e.name, e.to);
      writeFileSync(e.manifestPath, content);
    }
    console.log(`  applied ${pkgEdits.length} pkg.json edit(s), ${manifestEdits.length} manifest edit(s).\n`);
  } else {
    console.log("  (dry-run: no writes)\n");
  }
}

// ─── Phase 2: auto-commit ────────────────────────────────────────────────────

if (!SKIP_COMMIT) {
  console.log("Phase 2 — auto-commit");
  if (DRY_RUN) {
    console.log("  (dry-run: would `git add -A && git commit -m \"chore: republish at umbrella versions\"` if dirty)\n");
  } else {
    const status = tryExec("git status --porcelain");
    if (!status.ok) {
      console.error(`  STOP — git status failed: ${status.err.split("\n")[0]}`);
      process.exit(1);
    }
    if (!status.out) {
      console.log("  working tree clean; nothing to commit.\n");
    } else {
      const add = tryExec("git add -A");
      if (!add.ok) {
        console.error(`  STOP — git add failed: ${add.err.split("\n")[0]}`);
        process.exit(1);
      }
      const commit = tryExec(`git commit -m "chore: republish at umbrella versions"`);
      if (!commit.ok) {
        console.error(`  STOP — git commit failed: ${commit.err.split("\n")[0]}`);
        process.exit(1);
      }
      console.log("  commit created.\n");
    }
  }
} else {
  console.log("Phase 2 — auto-commit SKIPPED (--no-commit)\n");
}

// ─── Phase 3: pnpm changeset publish ─────────────────────────────────────────

console.log("Phase 3 — npm publish via `pnpm changeset publish`");
const tagsBefore = new Set(exec("git tag --list '@telorun/*'").split("\n").filter(Boolean));

if (DRY_RUN) {
  console.log("  (dry-run: would run `pnpm changeset publish`)\n");
} else {
  // Hard tree-clean precondition: tag SHAs reflect HEAD; a dirty tree means
  // tags would point at the wrong content.
  if (!SKIP_COMMIT) {
    const dirty = tryExec("git status --porcelain");
    if (dirty.ok && dirty.out) {
      console.error("  STOP — working tree dirty; refusing to publish (tag SHAs would be wrong).");
      console.error(dirty.out);
      process.exit(1);
    }
  }
  try {
    runLive("pnpm changeset publish");
  } catch {
    console.error("  STOP — `pnpm changeset publish` failed.");
    process.exit(1);
  }
  console.log("");
}

const tagsAfter = new Set(exec("git tag --list '@telorun/*'").split("\n").filter(Boolean));
const newTags = [...tagsAfter].filter((t) => !tagsBefore.has(t));

// ─── Phase 4: push new tags to remote ────────────────────────────────────────

console.log("Phase 4 — push tags to remote");
if (!newTags.length && !DRY_RUN) {
  console.log("  no new tags created; nothing to push.\n");
} else {
  if (DRY_RUN) {
    console.log(`  (dry-run: would push tags created by changeset publish to ${REMOTE})\n`);
  } else {
    const refspecs = newTags.map((t) => `refs/tags/${t}:refs/tags/${t}`).join(" ");
    const push = tryExec(`git push ${REMOTE} ${refspecs}`);
    if (!push.ok) {
      console.error(`  STOP — tag push failed: ${push.err.split("\n")[0]}`);
      console.error(`  rerun manually: git push ${REMOTE} ${refspecs}`);
      process.exit(1);
    }
    console.log(`  pushed ${newTags.length} tag(s).\n`);
  }
}

// ─── Phase 5: push module manifests to Telo registry ────────────────────────

console.log("Phase 5 — push module manifests to Telo registry");
async function registryHas(name, version) {
  const moduleName = name.replace(/^@telorun\//, "");
  const url = `${REGISTRY}/std/${moduleName}/${version}`;
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status === 200;
  } catch {
    return false;
  }
}

let pushed = 0;
let skipped = 0;
let failed = 0;
for (const [name, target] of Object.entries(UMBRELLA_TARGETS).sort()) {
  const moduleName = name.replace(/^@telorun\//, "");
  const manifestPath = join(ROOT, "modules", moduleName, "telo.yaml");
  if (!existsSync(manifestPath)) continue;

  const already = await registryHas(name, target);
  if (already) {
    console.log(`  ${name}@${target}: already on registry, skip`);
    skipped++;
    continue;
  }

  if (DRY_RUN) {
    console.log(`  ${name}@${target}: (dry-run) would push ${relative(ROOT, manifestPath)}`);
    continue;
  }

  try {
    runLive(
      `node ./cli/nodejs/bin/telo.mjs publish --skip-controllers --registry=${REGISTRY} ${manifestPath}`,
    );
    pushed++;
  } catch (err) {
    failed++;
    console.error(`  ${name}@${target}: push FAILED — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

if (!DRY_RUN) {
  console.log(`\n  registry result: ${pushed} pushed, ${skipped} skipped (already present), ${failed} failed`);
}

if (DRY_RUN) console.log("\nDry run. Re-run with --yes to execute.");
process.exit(failed ? 1 : 0);
