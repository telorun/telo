#!/usr/bin/env node
// Run from a published package's `prepack` hook: adds `overrides` and
// `pnpm.overrides` for every direct dependency, using the npm `$<name>` syntax
// (npm 8.3+), which pins the override to whatever version this very package.json
// declares for the dependency. `workspace:` ranges are left to the package
// manager, which writes them concrete into the packed manifest; the release
// planner refuses a packed one it did not.
//
// It writes the package's own `package.json`, so the `prepack` saves that file
// first and the `postpack` restores it (`pack-backup.mjs`).
//
// Usage: node scripts/prepack-bake-overrides.mjs <pkg-dir>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pkgDir = resolve(process.argv[2] ?? ".");
const pkgJsonPath = join(pkgDir, "package.json");
if (!existsSync(pkgJsonPath)) {
  console.error(`prepack-bake-overrides: ${pkgJsonPath} not found`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));

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
