#!/usr/bin/env node
// PR gate: every changed *published* package carries a changeset.
//
// `changeset status --since` used to be this check, but it counts private
// packages as versionable — which is deliberate and load-bearing, since that is
// what makes changesets bump the private `@telorun/<name>-build` dependents of a
// shared TS library and so propagate a fix into the modules that inline it. The
// consequence is that a module-only PR — a controller edit plus a changie
// fragment, no npm package touched — fails a check it should pass, and after the
// bundled migration that is the common shape of a PR.
//
// So this computes the same thing and then filters: a changed PRIVATE package is
// satisfied by the changie fragment its module already has to carry (enforced by
// check-changie-fragments.mjs); only a changed PUBLISHED package with no
// changeset fails.
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

for (const pkg of changedPackages(packages)) {
  // A private `-build` package's release ledger is changie, not changesets; the
  // module-change gate in check-changie-fragments.mjs already requires a fragment.
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
