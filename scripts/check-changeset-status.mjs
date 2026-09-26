#!/usr/bin/env node
// PR gate: every changed *published* package carries a changeset.
//
// `changeset status --since` used to be this check, but it counts private
// packages as versionable, so a module-only PR failed a check it should pass.
// This computes the same thing and then filters.
//
// Two exclusions, for two different reasons:
//
//   - A **module-owned** package (anything under `modules/*/nodejs/`) is not on
//     the changesets ledger at all any more: its version is its MODULE's version,
//     written by `telo release apply` into `telo.yaml`, `package.json` and
//     `Cargo.toml` together. The same set is in `.changeset/config.json`'s
//     `ignore`, so `changeset version` leaves it alone; without this filter every
//     module PR would fail here demanding a changeset for a version changesets is
//     no longer allowed to move.
//   - A **private** package is satisfied by whatever ledger owns it.
//
// Only a changed published, non-module package with no changeset fails.
//
// It also gates BAKED PINS — a package whose exact version is written into another
// package's published artifact, so that a release of the first is only reachable
// through a release of the second. `@telorun/debug-ui` is the case: the CLI reads
// its OWN `package.json` at runtime, takes the pinned debug-ui version out of it,
// and fetches exactly that version from the CDN. Changesets cannot see the edge —
// it propagates through `dependencies` / `peerDependencies` only, and this one is a
// devDependency precisely because the UI is fetched on demand rather than
// installed. So a debug-ui-only release publishes a UI that every installed CLI
// keeps ignoring, forever and silently. The gate reads the planned RELEASE (not the
// changeset text), so it also fires for a `debug-wire` change that reaches debug-ui
// by propagation.
//
// It also gates INLINED packages — a workspace package whose code ships inside
// another published package's build, so a change to it reaches users only through
// a release of the package that inlines it. The edge is DECLARED: a published
// package whose build inlines workspace code lists every such package — the full
// closure, direct and transitive — in a `teloInlines` array in its package.json
// (`@telorun/language-server` names the analyzer, editor-protocol, glob,
// ide-support, sdk and templating). Nothing is inferred from dependency fields,
// which say what is installed, not what is bundled. The declaration is kept
// honest from both ends: the build calls `verifyInlines` (exported here) against
// its bundler's metafile and fails unless the list is exactly what the bundle
// holds, and this gate fails on a listed name that is not a workspace package. A
// changed inlined package needs the inliner named by a changeset or moving in the
// planned release.
//
// It also gates the Rust twins of the telo version line: a crate at `<x>/rust`
// whose Node twin is on the line carries that twin's version
// (`version-line.mjs`), and a disagreement between the two halves of one
// artifact fails here.
//
// It also gates the `ignore` list itself, because that list is hand-maintained
// and changesets validates it as a WHOLE: an ignored package's dependent must be
// ignored too, so a new module depending on `@telorun/sql` makes `changeset
// version` refuse the config outright. Nothing in a PR reads the config, so that
// only surfaced on main, in the release workflow, after merge. The invariant is
// two-directional: every module-owned package is ignored (its version is the
// module's), and every ignore entry names a package that still exists (changesets
// rejects an unknown one).
//
// Usage: node scripts/check-changeset-status.mjs [base-ref]

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, loadWorkspace } from "./module-ownership.mjs";
import { rustTwinMismatches, workspacePackages } from "./version-line.mjs";

// Set by the CLI entry below; the exported `verifyInlines` needs none of them.
let baseRef;
let workspace;
let packages;
let covered;

/** Files npm packs whatever `files` says (npm-packlist's always-included set). */
const ALWAYS_PACKED = /^(package\.json|readme(\.[^/]*)?|licen[cs]e(\.[^/]*)?)$/i;

/** Whether `relative` (to the package dir) ships in the package's tarball. A package
 *  with no `files` field ships everything, so every change counts. */
function isPublished(pkg, relative) {
  const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"));
  if (!Array.isArray(manifest.files)) return true;
  if (ALWAYS_PACKED.test(relative)) return true;
  const entryPoints = [manifest.main, ...Object.values(manifest.bin ?? {})]
    .filter((entry) => typeof entry === "string")
    .map((entry) => normalize(entry));
  if (entryPoints.includes(relative)) return true;
  const matches = (pattern) => {
    const glob = normalize(pattern).replace(/\/$/, "");
    return matchesGlob(relative, glob) || matchesGlob(relative, `${glob}/**`);
  };
  const included = manifest.files.filter((p) => !p.startsWith("!")).some(matches);
  const excluded = manifest.files.filter((p) => p.startsWith("!")).some((p) => matches(p.slice(1)));
  return included && !excluded;
}

/** Workspace packages with at least one changed PUBLISHED file, by walking each
 *  changed path up to the nearest package directory. A change the tarball does not
 *  carry (a package's CLAUDE.md, its tests) releases nothing. */
function changedPackages(packages) {
  let diff;
  try {
    diff = execSync(`git diff --name-only ${baseRef}...HEAD`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // No merge base (a shallow clone, a fresh repo) — the gate cannot decide what
    // changed, and guessing would fail PRs at random.
    return [];
  }
  const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
  const changed = new Map();
  for (const file of diff.split("\n").filter(Boolean)) {
    let dir = resolve(ROOT, dirname(file));
    while (dir.startsWith(ROOT)) {
      const pkg = byDir.get(dir);
      if (pkg) {
        if (isPublished(pkg, relative(pkg.dir, resolve(ROOT, file)))) changed.set(pkg.name, pkg);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...changed.values()];
}

/** Package names named by any pending changeset. The front matter is a YAML
 *  mapping of `"name": bump`, one per line. */
function coveredByChangesets() {
  const covered = new Set();
  const dir = join(ROOT, ".changeset");
  if (!existsSync(dir)) return covered;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const text = readFileSync(join(dir, file), "utf8");
    const frontMatter = text.split(/^---$/m)[1];
    if (!frontMatter) continue;
    for (const line of frontMatter.split("\n")) {
      const match = /^\s*["']?(@?[^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line);
      if (match) covered.add(match[1].trim());
    }
  }
  return covered;
}

/** A package a MODULE owns — its version is the module's, moved by
 *  `telo release apply`, never by changesets. One reader, shared with the release
 *  and prune scripts (`module-ownership.mjs`). */
function moduleOwned(pkg) {
  return workspace.isModuleOwned(pkg.name);
}

/** The `ignore` list must name exactly the module-owned packages (plus whatever
 *  else is deliberately off the ledger), and nothing that no longer exists. */
function checkIgnoreList() {
  const config = JSON.parse(readFileSync(join(ROOT, ".changeset", "config.json"), "utf8"));
  const ignored = new Set(config.ignore ?? []);
  const byName = new Set(packages.map((pkg) => pkg.name));
  let bad = 0;
  for (const pkg of packages) {
    if (!moduleOwned(pkg) || ignored.has(pkg.name)) continue;
    console.error(
      `::error file=.changeset/config.json::${pkg.name} is module-owned but missing from the ` +
        `\`ignore\` list. Add it, or \`changeset version\` will refuse the config on main.`,
    );
    bad = 1;
  }
  for (const name of ignored) {
    if (byName.has(name)) continue;
    console.error(
      `::error file=.changeset/config.json::${name} is in the \`ignore\` list but is not a ` +
        `workspace package. Remove it — changesets rejects an unknown ignore entry.`,
    );
    bad = 1;
  }
  return bad;
}

/** A package whose exact version is baked into `consumer`'s published artifact,
 *  and so is only reachable by users through a release of `consumer`. */
const BAKED_PINS = [
  {
    pinned: "@telorun/debug-ui",
    consumer: "@telorun/cli",
    reason:
      "the CLI reads the debug-ui version out of its own published package.json and " +
      "fetches exactly that version from the CDN, so a debug-ui release the CLI does " +
      "not follow reaches nobody",
  },
];

/**
 * The pending release plan, as `{ name -> bump }` for packages that actually move.
 *
 * Read from changesets rather than recomputed: propagation through the dependency
 * graph is what changesets owns, and a second implementation of it would drift
 * silently. This is the same call `changeset version` makes, so the gate judges
 * exactly what a merge would produce.
 *
 * NOT through the `changeset status` CLI, which was the first attempt and failed in
 * CI: it computes changed-packages against the config's `baseBranch`, and a CI
 * checkout has `origin/main` but no local `main` — "Failed to find where HEAD
 * diverged from main". Passing `--since` fixes the ref but changes the ANSWER: it
 * filters the plan to changesets added since that ref, so a PR touching debug-ui
 * would be told to add a CLI changeset that main already carries. The library call
 * needs no ref at all.
 *
 * Resolved THROUGH `@changesets/cli` rather than added as a dependency of this repo,
 * so it is the same version the CLI itself uses — the two are released together and
 * read the config the same way.
 */
async function plannedReleases() {
  const here = createRequire(import.meta.url);
  const fromCli = createRequire(here.resolve("@changesets/cli/package.json"));
  const [planModule, { read: readConfig }, { getPackages }] = await Promise.all([
    import(fromCli.resolve("@changesets/get-release-plan")),
    import(fromCli.resolve("@changesets/config")),
    import(fromCli.resolve("@manypkg/get-packages")),
  ]);
  // These ship as CJS with an interop default, so importing one yields either the
  // function or a namespace wrapping it depending on the bundle.
  const getReleasePlan = planModule.default?.default ?? planModule.default;
  if (typeof getReleasePlan !== "function") {
    throw new Error("@changesets/get-release-plan did not export a callable default");
  }
  const found = await getPackages(ROOT);
  const plan = await getReleasePlan(ROOT, undefined, await readConfig(ROOT, found));
  return new Map(
    plan.releases.filter((r) => r.type && r.type !== "none").map((r) => [r.name, r.type]),
  );
}

/**
 * Every baked pin that moves must carry its consumer with it — and every declared
 * pin must still be real.
 *
 * The second half is what keeps the first from becoming a claim nothing verifies: if
 * the CLI ever drops the devDependency, or resolves the UI some other way, the entry
 * would go on demanding a CLI release forever while protecting nothing. The check is
 * that `consumer`'s manifest still names `pinned` in some dependency field.
 */
async function checkBakedPins(packages) {
  let bad = 0;
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  for (const { pinned, consumer } of BAKED_PINS) {
    const dir = byName.get(consumer)?.dir;
    const manifest = dir ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) : null;
    const named =
      manifest !== null &&
      ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
        (field) => manifest[field]?.[pinned] !== undefined,
      );
    if (named) continue;
    console.error(
      `::error file=scripts/check-changeset-status.mjs::BAKED_PINS claims ${consumer} pins ` +
        `${pinned}, but ${consumer}'s package.json no longer names it. Remove the entry, or ` +
        `restore the pin — as written the gate protects nothing.`,
    );
    bad = 1;
  }

  const changesets = readdirSync(join(ROOT, ".changeset")).filter(
    (file) => file.endsWith(".md") && file !== "README.md",
  );
  if (changesets.length === 0) return bad; // Nothing can move.

  let moving;
  try {
    moving = await plannedReleases();
  } catch (error) {
    const detail = (error.stderr ?? error.message ?? "").toString().trim();
    console.error(`::error::\`changeset status\` failed, so baked pins are unchecked: ${detail}`);
    return 1;
  }

  for (const { pinned, consumer, reason } of BAKED_PINS) {
    if (!moving.has(pinned) || moving.has(consumer)) continue;
    console.error(
      `::error::${pinned} is releasing (${moving.get(pinned)}) but ${consumer} is not. ` +
        `Add ${consumer} to a changeset — ${reason}.`,
    );
    bad = 1;
  }
  return bad;
}

/** A package's declared `teloInlines`, or `[]`. A value that is not an array of
 *  strings is a malformed declaration, refused rather than read as empty. */
function declaredInlines(dir, name) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const list = manifest.teloInlines ?? [];
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name}'s package.json declares teloInlines as something other than a list of package names.`);
  }
  return list;
}

/**
 * The build half of `teloInlines`: compare the declaration with what the bundle
 * actually holds. `metafile` is esbuild's, built with `absWorkingDir: packageDir`
 * (its input paths are relative to it); each input is attributed to the
 * workspace package whose directory contains it (third-party code under
 * `node_modules` is not a workspace package, and the package's own sources are
 * not an inline). Returns one message per disagreement, empty when the list is
 * exactly the bundle's set.
 */
export function verifyInlines(packageDir, metafile) {
  const dirs = [...workspacePackages()]
    .map(([name, { dir }]) => ({ name, dir: resolve(dir) }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const own = dirs.find((d) => d.dir === resolve(packageDir));
  if (!own) return [`${packageDir} is not a workspace package.`];

  const actual = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const file = resolve(packageDir, input);
    if (file.split(sep).includes("node_modules")) continue;
    const owner = dirs.find((d) => file.startsWith(d.dir + sep));
    if (owner && owner.name !== own.name) actual.add(owner.name);
  }
  const declared = new Set(declaredInlines(packageDir, own.name));

  const problems = [];
  for (const name of [...actual].sort()) {
    if (!declared.has(name)) {
      problems.push(`${name} is inlined into the bundle but missing from ${own.name}'s teloInlines.`);
    }
  }
  for (const name of [...declared].sort()) {
    if (!actual.has(name)) {
      problems.push(`${name} is listed in ${own.name}'s teloInlines but the bundle holds none of it.`);
    }
  }
  return problems;
}

/** Published packages' declared inlines, as `inlined -> inliners`, plus every
 *  listed name that is not a workspace package. */
function inliners(packages) {
  const byName = new Set(packages.map((pkg) => pkg.name));
  const result = new Map();
  const unknown = [];
  for (const pkg of packages) {
    if (pkg.private || moduleOwned(pkg)) continue;
    for (const name of declaredInlines(pkg.dir, pkg.name)) {
      if (!byName.has(name)) {
        unknown.push({ inliner: pkg.name, name });
        continue;
      }
      result.set(name, [...(result.get(name) ?? []), pkg.name]);
    }
  }
  return { byInlined: result, unknown };
}

/** A changed inlined package whose inliner is not releasing. */
async function checkInlined(changed) {
  const { byInlined, unknown } = inliners(packages);
  let bad = 0;
  for (const { inliner, name } of unknown) {
    console.error(
      `::error::${inliner}'s teloInlines names ${name}, which is not a workspace package. Remove ` +
        `it, or correct the name — as written the gate protects nothing for it.`,
    );
    bad = 1;
  }
  const needed = changed.flatMap((pkg) =>
    (byInlined.get(pkg.name) ?? []).map((inliner) => ({ inlined: pkg.name, inliner })),
  );
  if (needed.length === 0) return bad;
  let moving = new Map();
  if (readdirSync(join(ROOT, ".changeset")).some((f) => f.endsWith(".md") && f !== "README.md")) {
    try {
      moving = await plannedReleases();
    } catch (error) {
      const detail = (error.stderr ?? error.message ?? "").toString().trim();
      console.error(`::error::the release plan could not be read, so inlined packages are unchecked: ${detail}`);
      return 1;
    }
  }
  for (const { inlined, inliner } of needed) {
    if (covered.has(inliner) || moving.has(inliner)) continue;
    console.error(
      `::error::${inlined} changed and ${inliner} inlines it into its build, but ${inliner} is not ` +
        `releasing. Add ${inliner} to a changeset — the change reaches users only through it.`,
    );
    bad = 1;
  }
  return bad;
}

/** Rust twins that disagree with their Node twin. */
function checkRustTwins() {
  const mismatches = rustTwinMismatches(workspacePackages());
  for (const message of mismatches) console.error(`::error::${message}`);
  return mismatches.length > 0 ? 1 : 0;
}

async function main() {
  baseRef = process.argv[2] ?? "origin/main";
  workspace = loadWorkspace();
  packages = workspace.packages;
  covered = coveredByChangesets();

  const changed = changedPackages(packages);
  const ignoreListFailed = checkIgnoreList();
  const bakedPinsFailed = await checkBakedPins(packages);
  const inlinedFailed = await checkInlined(changed);
  const twinsFailed = checkRustTwins();
  let failed = ignoreListFailed || bakedPinsFailed || inlinedFailed || twinsFailed ? 1 : 0;

  for (const pkg of changed) {
    if (moduleOwned(pkg)) continue;
    if (pkg.private) continue;
    if (covered.has(pkg.name)) continue;
    console.error(
      `::error::${pkg.name} changed a published file but no changeset covers it. Add one with ` +
        `\`pnpm changeset\` naming ${pkg.name} with a bump — an empty changeset names no package ` +
        `and does not cover it.`,
    );
    failed = 1;
  }

  if (failed === 0) console.log("check-changeset-status: every changed published package is covered.");
  process.exit(failed);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
