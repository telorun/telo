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
// Usage: node scripts/check-changeset-status.mjs [base-ref]

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseRef = process.argv[2] ?? "origin/main";

/** Every workspace package, as `{ dir, name, private }`. */
function workspacePackages() {
  const listed = JSON.parse(
    execSync("pnpm -r list --depth -1 --json", { cwd: ROOT, encoding: "utf8" }),
  );
  return listed
    .filter((pkg) => pkg.name && pkg.path)
    .map((pkg) => ({ dir: resolve(pkg.path), name: pkg.name, private: pkg.private === true }));
}

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

const packages = workspacePackages();
const covered = coveredByChangesets();
let failed = 0;

/** A package a MODULE owns — its version is the module's, moved by
 *  `telo release apply`, never by changesets. */
function moduleOwned(pkg) {
  return resolve(pkg.dir).startsWith(join(ROOT, "modules") + "/");
}

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
