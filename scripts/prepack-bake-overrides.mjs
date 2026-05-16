#!/usr/bin/env node
// Run from a published package's `prepack` hook. The script:
//
//   1. Reads the package.json sitting at <pkg-dir>/package.json.
//   2. Rewrites any remaining `workspace:` specifiers in dependencies /
//      peerDependencies / optionalDependencies, by looking up the local
//      version of the named package elsewhere in the monorepo. pnpm normally
//      does this rewrite during publish, but we have seen it silently miss in
//      CI (causing kernel + cli to ship a workspace: poison tarball, or — with
//      this script in place — to fail the publish entirely). Doing the
//      rewrite ourselves makes the publish robust to whatever upstream tool
//      decides to do (pnpm pack, npm publish, changeset publish, …).
//   3. Adds `overrides` and `pnpm.overrides` for every direct dependency,
//      using the npm `$<name>` syntax (npm 8.3+) which pins the override to
//      whatever version this very package.json declares for the dep.
//   4. Re-runs scripts/generate-runtime-deps.mjs against the rewritten
//      package.json so the runtime carries the same name list the published
//      manifest declares.
//
// Usage: node scripts/prepack-bake-overrides.mjs <pkg-dir>
// Env:   TELO_PREPACK_WORKSPACE_ROOT overrides the monorepo root used for
//        sibling lookups (tests use this; the prepack hook does not).

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRuntimeDeps } from "./generate-runtime-deps.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.TELO_PREPACK_WORKSPACE_ROOT
  ? resolve(process.env.TELO_PREPACK_WORKSPACE_ROOT)
  : resolve(__dirname, "..");

// Directories never worth descending into when scanning for sibling
// package.jsons. `dist` is included so a stale dist/package.json (rare, but
// possible after a faulty build) cannot poison the version map.
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build", ".changeset", ".github"]);

function collectWorkspaceVersions(root) {
  const versions = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "package.json") {
        try {
          const pkg = JSON.parse(readFileSync(full, "utf8"));
          if (typeof pkg.name === "string" && typeof pkg.version === "string") {
            versions.set(pkg.name, pkg.version);
          }
        } catch {
          // unreadable / invalid package.json — skip silently
        }
      }
    }
  }
  walk(root);
  return versions;
}

function resolveWorkspaceSpec(spec, version) {
  const rest = spec.slice("workspace:".length);
  if (rest === "" || rest === "*") return version;
  if (rest === "^") return `^${version}`;
  if (rest === "~") return `~${version}`;
  // `workspace:1.2.3` / `workspace:^1.2.3` — strip the prefix; the remainder
  // is already a real range.
  return rest;
}

const pkgDir = resolve(process.argv[2] ?? ".");
const pkgJsonPath = join(pkgDir, "package.json");
if (!existsSync(pkgJsonPath)) {
  console.error(`prepack-bake-overrides: ${pkgJsonPath} not found`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));

const depSections = ["dependencies", "peerDependencies", "optionalDependencies"];
let workspaceVersions = null;
const rewrites = [];
for (const section of depSections) {
  const obj = pkg[section];
  if (!obj || typeof obj !== "object") continue;
  for (const [name, spec] of Object.entries(obj)) {
    if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
    if (workspaceVersions === null) {
      workspaceVersions = collectWorkspaceVersions(WORKSPACE_ROOT);
    }
    const version = workspaceVersions.get(name);
    if (!version) {
      console.error(
        `prepack-bake-overrides: ${pkg.name} → ${section}.${name} is "${spec}", but no package.json with name "${name}" was found under ${WORKSPACE_ROOT}. Refusing to publish a tarball with an unresolved workspace: specifier.`,
      );
      process.exit(2);
    }
    const resolved = resolveWorkspaceSpec(spec, version);
    obj[name] = resolved;
    rewrites.push(`${section}.${name}: "${spec}" → "${resolved}"`);
  }
}

if (rewrites.length > 0) {
  console.log(
    `prepack-bake-overrides: ${pkg.name} → rewrote ${rewrites.length} workspace: specifier(s) (pnpm normally does this; doing it here so a missed upstream rewrite no longer fails the release).`,
  );
  for (const r of rewrites) console.log(`  ${r}`);
}

const deps = Object.entries(pkg.dependencies ?? {});

const overrides = {};
for (const [name] of deps) {
  overrides[name] = `$${name}`;
}

const updated = {
  ...pkg,
  overrides: { ...(pkg.overrides ?? {}), ...overrides },
  pnpm: { ...(pkg.pnpm ?? {}), overrides: { ...(pkg.pnpm?.overrides ?? {}), ...overrides } },
};

writeFileSync(pkgJsonPath, JSON.stringify(updated, null, 2) + "\n");
console.log(
  `prepack-bake-overrides: ${pkg.name} → ${deps.length} overrides written to ` +
    `package.json (and pnpm.overrides mirror).`,
);

// Regenerate runtime-deps.json against the rewritten manifest so runtime
// metadata matches the published deps list exactly. Direct call (rather
// than fork-exec) keeps `pkgDir` out of any shell — argument quoting was
// the previous shape's footgun — and avoids the cost of spinning a second
// Node process during pack.
const runtimeDepsPath = generateRuntimeDeps(pkgDir);
console.log(`prepack-bake-overrides: regenerated ${runtimeDepsPath}`);
