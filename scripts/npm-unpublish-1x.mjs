#!/usr/bin/env node
// Take every @telorun/* package version >= 1.0.0 off the public install path
// on npm, delete the matching git tags (local + remote), and fold the
// stripped CHANGELOG sections into a single umbrella `## <new-stable>`
// heading per package — preserving the descriptive content for the next
// published release without leaving a gap in the history.
//
// For each bad version the script tries `npm unpublish` first; if npm refuses
// with E405 ("you can no longer unpublish... has dependent packages") it
// falls back to `npm deprecate` so the version stays installable but ships a
// deprecation warning. Both outcomes are followed by tag + changelog cleanup.
// Only a deprecate FAILURE (network, auth) stops the script.
//
// CONTEXT: a botched changeset bumped multiple pre-1.0 packages into 1.x / 2.x
// territory. Telo is pre-public; we are resetting all affected packages back
// to the 0.x line. Once unpublished, those version strings are BURNT FOREVER
// on npm.
//
// RESUMABLE: targets are re-derived from observable state on every run —
//   - npm targets: versions where major >= 1 still present in `npm view ... versions`
//   - tag targets: local tags `@telorun/*@<v>` with major >= 1
//   - changelog targets: any `## X.Y.Z` (major >= 1) section still in CHANGELOG.md
// Actions already completed on a prior run drop off the target list naturally.
// On any failure within a package, the script stops; re-run picks up where it
// left off.
//
// USAGE:
//   node scripts/npm-unpublish-1x.mjs            # dry-run
//   node scripts/npm-unpublish-1x.mjs --yes      # execute
//
// ENV:
//   GIT_REMOTE   remote to push tag deletions to (default: origin)
//
// BEFORE RUNNING --yes:
//   1. Review UMBRELLA_TARGETS below — set the new stable version per package.
//      Missing entries → script stops at that package with a clear error.
//   2. Review EXCLUDE if you want to preserve any package's 1.x history.
//   3. Run dry-run first; it lists every action that would happen.

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UMBRELLA_TARGETS } from "./lib/umbrella-targets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DRY_RUN = !process.argv.includes("--yes");
const REMOTE = process.env.GIT_REMOTE ?? "origin";

const EXCLUDE = new Set([
  // "@telorun/s3",  // uncomment to skip s3 entirely (preserves its 1.x line on npm)
]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".telo", ".git", ".pnpm", "tmp"]);

const VERSION_HEADING = /^## (\d+\.\d+\.\d+(?:[-+][\w.-]*)?)\s*$/;
const SUBHEADING = /^### (Major|Minor|Patch) Changes\s*$/;

function exec(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function tryExec(cmd) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(),
    };
  } catch (err) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    return { ok: false, err: (stderr || stdout || err.message).trim() };
  }
}

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

function majorOf(version) {
  return parseInt(version.split(".")[0], 10);
}

// Split CHANGELOG.md into the preamble (everything before the first version
// heading) and an array of sections. Each section captures the heading version
// and the lines between this heading and the next (or EOF), with the heading
// line itself excluded from the body.
function parseChangelog(text) {
  const lines = text.split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(VERSION_HEADING);
    if (m) {
      if (current) sections.push(current);
      current = { version: m[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

// Parse a section body into Major/Minor/Patch chunks plus any leading lines
// that fall outside those subheadings (rare; preserved as "other").
function parseSectionBody(bodyLines) {
  const buckets = { Major: [], Minor: [], Patch: [], other: [] };
  let active = "other";
  for (const line of bodyLines) {
    const m = line.match(SUBHEADING);
    if (m) {
      active = m[1];
      continue;
    }
    buckets[active].push(line);
  }
  // Trim leading/trailing blank lines per bucket so concatenation doesn't
  // produce gaps the size of N empty lines.
  for (const key of Object.keys(buckets)) {
    const arr = buckets[key];
    while (arr.length && arr[0].trim() === "") arr.shift();
    while (arr.length && arr[arr.length - 1].trim() === "") arr.pop();
  }
  return buckets;
}

function rewriteCrossRefs(line, umbrellaMap) {
  // Match `@telorun/<name>@<version>` and rewrite the version if the name is
  // in the umbrella map. Conservative regex: name allows kebab-case only,
  // version is a semver-ish triple with optional pre-release/build.
  return line.replace(
    /(@telorun\/[a-z0-9][a-z0-9-]*)@\d+\.\d+\.\d+(?:[-+][\w.-]*)?/g,
    (full, pkgName) => {
      const target = umbrellaMap[pkgName];
      return target ? `${pkgName}@${target}` : full;
    },
  );
}

function buildUmbrellaBlock(umbrellaVersion, badSections, umbrellaMap) {
  // Newest first — sections are in file order, which changesets writes
  // newest-first by convention, so this is already chronologically correct.
  const merged = { Major: [], Minor: [], Patch: [] };
  for (const section of badSections) {
    const buckets = parseSectionBody(section.body);
    for (const kind of ["Major", "Minor", "Patch"]) {
      if (!buckets[kind].length) continue;
      // Rewrite cross-refs inline.
      const rewritten = buckets[kind].map((l) => rewriteCrossRefs(l, umbrellaMap));
      if (merged[kind].length) merged[kind].push(""); // blank separator between contributions
      merged[kind].push(...rewritten);
    }
    // "other" lines are skipped — in practice these are blank lines between
    // the version heading and the first subheading, which carry no content.
  }
  const out = [`## ${umbrellaVersion}`, ""];
  for (const kind of ["Major", "Minor", "Patch"]) {
    if (!merged[kind].length) continue;
    out.push(`### ${kind} Changes`, "");
    out.push(...merged[kind]);
    out.push("");
  }
  // Trim trailing blanks then add one terminal blank to space against the
  // next section.
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function rebuildChangelog(parsed, badVersions, umbrellaVersion, umbrellaBlock) {
  const bad = new Set(badVersions);
  const kept = parsed.sections.filter((s) => !bad.has(s.version));

  // Detect an existing umbrella section so re-runs extend it instead of
  // stacking a second `## <umbrella>` heading. If present, replace its body
  // with the freshly merged umbrella block (which by construction already
  // includes the prior content via the orphan-detection path).
  const existingUmbrellaIdx = kept.findIndex((s) => s.version === umbrellaVersion);
  if (existingUmbrellaIdx !== -1) kept.splice(existingUmbrellaIdx, 1);

  // Preamble (title) → umbrella → kept 0.x history.
  const out = [];
  const preamble = parsed.preamble.slice();
  while (preamble.length && preamble[preamble.length - 1] === "") preamble.pop();
  if (preamble.length) {
    out.push(...preamble, "");
  }
  out.push(umbrellaBlock, "");
  for (const s of kept) {
    out.push(`## ${s.version}`);
    out.push(...s.body);
  }
  // Normalize trailing whitespace.
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

// ─── Main ────────────────────────────────────────────────────────────────────

const me = exec("npm whoami");
console.log(`npm user:   ${me}`);
console.log(`git remote: ${REMOTE}`);
console.log(`mode:       ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
if (EXCLUDE.size) console.log(`excluded:   ${[...EXCLUDE].join(", ")}`);
console.log("");

const localTags = new Set(exec("git tag --list '@telorun/*'").split("\n").filter(Boolean));

// Map @telorun/<name> → { dir, pkg } for every workspace package we'll
// consider for unpublish. The full package.json is retained so we can build
// the inter-package dependency graph below.
const pkgFiles = walk(ROOT);
const pkgInfo = new Map();
for (const f of pkgFiles) {
  try {
    const p = JSON.parse(readFileSync(f, "utf8"));
    if (p.name?.startsWith("@telorun/") && !p.private && !EXCLUDE.has(p.name)) {
      pkgInfo.set(p.name, { dir: dirname(f), pkg: p });
    }
  } catch {}
}

// Topological order — leaves first. npm refuses to unpublish a version that
// has any currently-published dependent package, so we have to walk the
// dependency graph from the top down: high-level consumers (cli, ai-openai,
// lambda) drained first; foundations (kernel, sdk, http-dispatch, ai) drained
// last, once nothing depends on them anymore.
//
// We build the graph from the current workspace package.json files. That's a
// proxy for "what got published in the 1.x line" — accurate for our case
// because changesets bumped the trio + cascaded to dependents together. If a
// future version published with a different dep shape, npm's policy check
// will still surface the truth (E405 on unpublish), and the user can run
// again after manually handling the outlier.
function topoSort(packages) {
  const nodes = new Set(packages.keys());
  // Edge `A → B` = "A depends on B" (i.e. A must be unpublished before B).
  const edges = new Map();
  for (const n of nodes) edges.set(n, new Set());

  for (const [name, { pkg }] of packages) {
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };
    for (const dep of Object.keys(allDeps)) {
      if (dep !== name && nodes.has(dep)) edges.get(name).add(dep);
    }
  }

  // Kahn's: in-degree = number of incoming edges (= number of packages that
  // depend on this one). Start with in-degree 0 — packages nothing depends on.
  const inDeg = new Map();
  for (const n of nodes) inDeg.set(n, 0);
  for (const tos of edges.values()) {
    for (const to of tos) inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
  }

  const ready = [...nodes].filter((n) => inDeg.get(n) === 0).sort();
  const out = [];
  while (ready.length) {
    const n = ready.shift();
    out.push(n);
    const neighbors = [...edges.get(n)].sort();
    for (const to of neighbors) {
      const d = (inDeg.get(to) ?? 0) - 1;
      inDeg.set(to, d);
      if (d === 0) {
        // Keep ready alphabetical within a topological "level" for stable output.
        const idx = ready.findIndex((x) => x > to);
        if (idx === -1) ready.push(to);
        else ready.splice(idx, 0, to);
      }
    }
  }

  // Cycle fallback: any package still missing from `out` is part of a cycle.
  // Append in alphabetical order so behaviour stays deterministic; the user
  // gets a warning so they know the order isn't fully sound.
  if (out.length < nodes.size) {
    const seen = new Set(out);
    const stragglers = [...nodes].filter((n) => !seen.has(n)).sort();
    console.warn(
      `\nWARNING: dependency cycle detected among: ${stragglers.join(", ")}. ` +
        `Appending in alphabetical order; some unpublishes may hit E405.\n`,
    );
    out.push(...stragglers);
  }
  return out;
}

const processOrder = topoSort(pkgInfo);

console.log(`Processing order (leaves first):`);
for (let i = 0; i < processOrder.length; i += 4) {
  console.log("  " + processOrder.slice(i, i + 4).join(", "));
}
console.log("");

const tagsToDeleteRemote = [];
let totalUnpublished = 0;
let totalDeprecated = 0;
let totalTagsDeleted = 0;
let totalChangelogsRewritten = 0;

// E405 fallback message. Stored on the deprecated version's npm metadata and
// shown to anyone who installs it.
const DEPRECATE_MESSAGE = "Pre-1.0 RC release; use the 0.x line on @telorun.";

function pushRemoteTagsIfAny() {
  if (!tagsToDeleteRemote.length) return { ok: true };
  const refspecs = tagsToDeleteRemote.map((t) => `:refs/tags/${t}`).join(" ");
  console.log(`\nDeleting ${tagsToDeleteRemote.length} tag(s) on remote '${REMOTE}'...`);
  if (DRY_RUN) {
    console.log(`  (dry-run) would: git push ${REMOTE} ${refspecs}`);
    return { ok: true };
  }
  const push = tryExec(`git push ${REMOTE} ${refspecs}`);
  if (push.ok) {
    console.log(`  ${tagsToDeleteRemote.length} remote tag(s) deleted`);
    return { ok: true };
  }
  console.error(`  remote tag delete FAILED — ${push.err.split("\n")[0]}`);
  console.error("  local tags are already gone; remote still has them. Re-run:");
  console.error(`    git push ${REMOTE} ${refspecs}`);
  return { ok: false };
}

function stop(reason, exitCode = 1) {
  console.error(`\nSTOP: ${reason}`);
  const pushed = pushRemoteTagsIfAny();
  process.exit(pushed.ok ? exitCode : exitCode || 1);
}

for (const name of processOrder) {
  const { dir } = pkgInfo.get(name);
  const changelogPath = join(dir, "CHANGELOG.md");

  // npm-side targets (versions still on npm with major >= 1).
  const view = tryExec(`npm view ${name} versions --json`);
  let npmVersions = [];
  if (view.ok) {
    const parsed = JSON.parse(view.out);
    npmVersions = Array.isArray(parsed) ? parsed : [parsed];
  } else if (!/E404|404 Not Found/i.test(view.err)) {
    stop(`npm view failed for ${name}: ${view.err.split("\n")[0]}`);
  }
  const npmBad = npmVersions.filter((v) => majorOf(v) >= 1);

  // Changelog-side targets (sections with major >= 1 still in the file).
  let changelogText = null;
  let changelogParsed = null;
  let clBad = [];
  try {
    changelogText = readFileSync(changelogPath, "utf8");
    changelogParsed = parseChangelog(changelogText);
    clBad = changelogParsed.sections.filter((s) => majorOf(s.version) >= 1);
  } catch {
    /* changelog absent — fine */
  }

  // Orphan sections: in changelog but no longer on npm (unpublished by a
  // prior run that crashed before rewriting the file).
  const npmBadSet = new Set(npmBad);
  const orphanSections = clBad.filter((s) => !npmBadSet.has(s.version));

  // Anything to do for this package?
  if (!npmBad.length && !clBad.length) continue;

  console.log(`\n${name}:`);
  if (npmBad.length) console.log(`  npm versions to unpublish: ${npmBad.join(", ")}`);
  if (orphanSections.length) {
    console.log(
      `  orphan changelog sections (already off npm): ${orphanSections.map((s) => s.version).join(", ")}`,
    );
  }
  if (clBad.length) {
    const umbrella = UMBRELLA_TARGETS[name];
    console.log(`  umbrella target: ${umbrella ?? "(MISSING — add to UMBRELLA_TARGETS)"}`);
  }

  if (DRY_RUN) continue;

  // ── Live mode for this package ──
  if (clBad.length && !UMBRELLA_TARGETS[name]) {
    stop(`no UMBRELLA_TARGETS entry for ${name}; edit the script and rerun`);
  }

  // Unpublish + local-tag delete for every npm-side bad version. On E405 ("has
  // dependent packages — you can no longer unpublish"), fall back to
  // `npm deprecate` so the version stays installable but ships a warning.
  // Tag + changelog cleanup proceeds identically in both cases — a deprecated
  // version is still being functionally replaced by the umbrella publish.
  // Only a deprecate FAILURE (auth, network) stops the script.
  for (const version of npmBad) {
    process.stdout.write(`  unpublish ${name}@${version} ... `);
    const unpub = tryExec(`npm unpublish ${name}@${version} --force`);
    if (unpub.ok) {
      console.log("ok");
      totalUnpublished++;
    } else if (/E405|can no longer unpublish|has dependent/i.test(unpub.err)) {
      // Pre-check: if the version is already deprecated (e.g. from a prior
      // run whose deprecate succeeded but exited non-zero due to npm's
      // notice-on-stderr behavior), re-running `npm deprecate` errors.
      // Treat already-deprecated as success.
      const existing = tryExec(`npm view ${name}@${version} deprecated`);
      if (existing.ok && existing.out) {
        console.log("already deprecated; skip");
        totalDeprecated++;
      } else {
        process.stdout.write("E405; deprecate instead ... ");
        const dep = tryExec(
          `npm deprecate "${name}@${version}" ${JSON.stringify(DEPRECATE_MESSAGE)}`,
        );
        if (!dep.ok) {
          const meaningful = dep.err
            .split("\n")
            .filter((l) => !/^npm notice /.test(l))
            .join("\n");
          console.log("FAILED");
          console.error(meaningful || dep.err);
          stop(`npm deprecate fallback failed for ${name}@${version}`);
        }
        console.log("ok (deprecated)");
        totalDeprecated++;
      }
    } else {
      console.log(`FAILED — ${unpub.err.split("\n")[0]}`);
      stop(`npm unpublish failed for ${name}@${version}`);
    }

    const tag = `${name}@${version}`;
    if (localTags.has(tag)) {
      const tagDel = tryExec(`git tag -d "${tag}"`);
      if (!tagDel.ok) {
        console.log(`    local tag delete FAILED — ${tagDel.err.split("\n")[0]}`);
        stop(`local tag delete failed for ${tag}`);
      }
      tagsToDeleteRemote.push(tag);
      totalTagsDeleted++;
      console.log(`    tag deleted: ${tag}`);
    }
  }

  // Rewrite the CHANGELOG: fold all bad sections (both freshly unpublished
  // and orphans from prior runs) into the umbrella heading.
  if (clBad.length) {
    const umbrellaVersion = UMBRELLA_TARGETS[name];
    const umbrellaBlock = buildUmbrellaBlock(umbrellaVersion, clBad, UMBRELLA_TARGETS);
    const next = rebuildChangelog(
      changelogParsed,
      clBad.map((s) => s.version),
      umbrellaVersion,
      umbrellaBlock,
    );
    try {
      writeFileSync(changelogPath, next);
      console.log(
        `    changelog rewritten: ${relative(ROOT, changelogPath)} → umbrella ## ${umbrellaVersion}`,
      );
      totalChangelogsRewritten++;
    } catch (err) {
      stop(`changelog write failed for ${relative(ROOT, changelogPath)}: ${err.message}`);
    }
  }
}

// Flush remote tag deletions.
const pushed = pushRemoteTagsIfAny();

console.log(
  `\nresult: ${totalUnpublished} unpublished, ${totalDeprecated} deprecated (E405 fallback), ` +
    `${totalTagsDeleted} local tag(s) deleted, ${totalChangelogsRewritten} changelog(s) rewritten`,
);
if (DRY_RUN) console.log("\nDry run. Re-run with --yes to execute.");
process.exit(pushed.ok ? 0 : 1);
