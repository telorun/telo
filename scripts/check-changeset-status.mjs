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
import { dirname, join, resolve } from "node:path";
import { ROOT, loadWorkspace } from "./module-ownership.mjs";

const baseRef = process.argv[2] ?? "origin/main";

/** Workspace packages with at least one changed file, by walking each changed
 *  path up to the nearest package directory. */
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
        changed.set(pkg.name, pkg);
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

const workspace = loadWorkspace();
const packages = workspace.packages;
const covered = coveredByChangesets();
let failed = 0;

/** A package a MODULE owns — its version is the module's, moved by
 *  `telo release apply`, never by changesets. One reader, shared with the release
 *  and prune scripts (`module-ownership.mjs`). */
const moduleOwned = (pkg) => workspace.isModuleOwned(pkg.name);

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

const ignoreListFailed = checkIgnoreList();
const bakedPinsFailed = await checkBakedPins(packages);
failed = ignoreListFailed || bakedPinsFailed ? 1 : 0;

for (const pkg of changedPackages(packages)) {
  if (moduleOwned(pkg)) continue;
  if (pkg.private) continue;
  if (covered.has(pkg.name)) continue;
  console.error(
    `::error::${pkg.name} changed but no changeset covers it. Add one with \`pnpm changeset\`, ` +
      `or \`pnpm changeset add --empty\` if the change genuinely needs no release.`,
  );
  failed = 1;
}

if (failed === 0) console.log("check-changeset-status: every changed published package is covered.");
process.exit(failed);
