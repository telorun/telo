#!/usr/bin/env node
// Writes a `runtime-deps.json` that lists the kernel-side packages whose
// realpath must be shared with every loaded controller. The npm-loader
// reads this at runtime, then writes `file:<kernel-side-realpath>` deps
// for each name into the per-manifest install root's package.json — making
// `@telorun/sdk` (and any other listed package) a symlink shared with the
// kernel, so class identity (most notably the `Stream` constructor) holds
// across the kernel/controller realm boundary.
//
// Why this list is narrow rather than "all kernel deps":
//   - Class-identity-sensitive packages need realm collapse (today: SDK).
//   - Pure libraries (yaml, packageurl-js, ajv-formats, …) work fine when
//     duplicated; copying them via `file:` only adds workspace-specifier
//     headaches in dev mode.
//   - `@telorun/analyzer` has `workspace:*` deps on the SDK; `file:`-aliasing
//     it would force npm to resolve workspace specifiers it doesn't understand.
//
// Add a name here if you ship another shared runtime symbol whose `instanceof`
// or constructor identity matters across module boundaries.
//
// CLI:    node scripts/generate-runtime-deps.mjs <pkg-dir>
// API:    import { generateRuntimeDeps } from "./generate-runtime-deps.mjs"
//         await generateRuntimeDeps(pkgDir)

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REALM_COLLAPSE_NAMES = ["@telorun/sdk"];

/**
 * Generate `<pkg-dir>/dist/generated/runtime-deps.json` for the given
 * package. Throws if the package directory doesn't contain a `package.json`
 * (the path is almost certainly wrong in that case). Returns the path of
 * the generated file so callers can log it.
 */
export function generateRuntimeDeps(pkgDir) {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`generate-runtime-deps: ${pkgJsonPath} not found`);
  }

  const out = {
    generated: "scripts/generate-runtime-deps.mjs",
    // Names whose kernel-side realpath the runtime should bind into the
    // install-root tree as `file:` deps. Order is preserved.
    names: REALM_COLLAPSE_NAMES,
  };

  const outDir = join(pkgDir, "dist", "generated");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "runtime-deps.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  return outPath;
}

// Run as a script when invoked directly. The check matches `node script.mjs`
// and `pnpm` script invocations; importers see only the named export above.
const isDirectInvocation = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectInvocation) {
  const pkgDir = resolve(process.argv[2] ?? ".");
  try {
    const outPath = generateRuntimeDeps(pkgDir);
    console.log(
      `generate-runtime-deps: ${REALM_COLLAPSE_NAMES.length} realm-collapse name(s) → ${outPath}`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
