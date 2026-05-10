#!/usr/bin/env node
// Run from a published package's `prepack` hook (npm/pnpm invoke this AFTER
// `workspace:*` has been rewritten to a real version spec but BEFORE the
// tarball is sealed). The script:
//
//   1. Reads the rewritten package.json sitting at <pkg-dir>/package.json.
//   2. Asserts no `workspace:` specifiers remain — if any do, the rewrite
//      step did not run and any emitted overrides would be poison (`$@x/y`
//      pointing at `workspace:*`). This is a hard error.
//   3. Adds `overrides` and `pnpm.overrides` for every direct dependency,
//      using the npm `$<name>` syntax (npm 8.3+) which pins the override to
//      whatever version this very package.json declares for the dep. This is
//      belt-and-braces: the runtime install root we create at boot already
//      pins the same names, but a user who installs the kernel directly
//      benefits from these too.
//   4. Re-runs scripts/generate-runtime-deps.mjs against the rewritten
//      package.json so the runtime carries the same name list the published
//      manifest declares.
//
// Usage: node scripts/prepack-bake-overrides.mjs <pkg-dir>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateRuntimeDeps } from "./generate-runtime-deps.mjs";

const pkgDir = resolve(process.argv[2] ?? ".");
const pkgJsonPath = join(pkgDir, "package.json");
if (!existsSync(pkgJsonPath)) {
  console.error(`prepack-bake-overrides: ${pkgJsonPath} not found`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const deps = Object.entries(pkg.dependencies ?? {});

// Workspace specifiers must be rewritten before this script runs — otherwise
// `$@telorun/sdk` resolves to a `workspace:*` value no consumer can match.
// pnpm does this rewrite during pack; bun's pack does not. Failing here is
// preferable to publishing a broken tarball.
const workspaceLeaks = deps.filter(([, v]) => typeof v === "string" && v.startsWith("workspace:"));
if (workspaceLeaks.length > 0) {
  console.error(
    `prepack-bake-overrides: package.json still has ${workspaceLeaks.length} workspace: specifier(s). ` +
      `pnpm should rewrite these before prepack runs. Offenders: ${workspaceLeaks
        .map(([name]) => name)
        .join(", ")}`,
  );
  process.exit(2);
}

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
