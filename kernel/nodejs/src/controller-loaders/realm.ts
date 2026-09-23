import * as path from "path";
import type { Logger } from "@telorun/sdk";
import * as sdk from "@telorun/sdk";
import ajvEqual from "ajv/dist/runtime/equal.js";
import ajvParseJson from "ajv/dist/runtime/parseJson.js";
import ajvQuote from "ajv/dist/runtime/quote.js";
import ajvTimestamp from "ajv/dist/runtime/timestamp.js";
import ajvUcs2length from "ajv/dist/runtime/ucs2length.js";
import ajvUri from "ajv/dist/runtime/uri.js";
import ajvValidationError from "ajv/dist/runtime/validation_error.js";
import ajvFormats from "ajv-formats/dist/formats.js";
import {
  clearLinkedSlot,
  isWritableShimSlot,
  shimPackageJson,
  writeIfChanged,
} from "./shim-package.js";

/**
 * The realm: bare specifiers that must resolve to the **kernel's own loaded
 * instance** rather than to a second copy, and the mechanism that makes them.
 *
 * Two kinds of consumer import them. A controller bundle imports `@telorun/sdk`
 * for the value domain whose identity is load-bearing (`Stream`, `InvokeError`,
 * `Duration`): a second copy makes every `instanceof` across the boundary false.
 * A compiled validator, read back off disk, imports ajv's runtime helpers, which
 * must be the ajv this kernel validates with.
 *
 * **The resolution is a generated package, not a symlink.** A symlink needs the
 * kernel's copy to exist as a directory on disk, which is exactly what a
 * single-file executable does not have — the SDK is inside the binary. The
 * generated package re-exports what the running kernel has already loaded and
 * published here, so it holds wherever the kernel does: a checkout, an npm
 * install, a container, a binary. It is also the one mechanism that works on
 * every runtime — module resolve hooks are honoured by Node but not by Bun,
 * which this repo's own test suite runs under.
 *
 * Identity holds because the shim reads the instance out of the process rather
 * than resolving a package: every shim in every bundle directory hands back the
 * same object the kernel is using.
 */

/** Kernel-owned realm names an npm-delivered controller gets as `file:` deps in
 *  its install root. That tree is reconciled by a package manager, which prunes
 *  what it did not install and (pnpm, by default) installs a missing peer from
 *  the registry — so a generated package there would be removed or shadowed by a
 *  registry copy, which is two SDK instances in one process. The install root
 *  only exists where a package manager does, so it keeps the `file:` dep and
 *  nothing is unified away. */
export const REALM_COLLAPSE_NAMES: ReadonlyArray<string> = ["@telorun/sdk"];

/** Where the registry hangs. `Symbol.for` rather than a module-level export: a
 *  shim is a separate file loaded by the runtime's own resolution, so the
 *  process is the only thing it and the kernel share. */
const REALM_KEY = Symbol.for("telo.realm");

/** An entry's module shape, which decides what a shim for it looks like. `esm`
 *  is imported by package name and re-exports named bindings; `cjs` is required
 *  by deep path and hands back one module object. */
type RealmFormat = "esm" | "cjs";

interface RealmEntry {
  readonly specifier: string;
  readonly format: RealmFormat;
  readonly module: Record<string, unknown>;
}

/**
 * The CommonJS `module.exports` shape a caller of `require` expects, from
 * whatever this runtime's interop handed the static import.
 *
 * A compiled validator reads `require("ajv/dist/runtime/equal").default`, so
 * what the realm hands back must be the module object, not the function inside
 * it — and which of the two an ESM default import yields depends on the loader:
 * Node gives the module object, Vitest's interop unwraps it to the function.
 * Re-wrapping a function restores the one shape both agree on. An object is
 * already that shape, whether it carries `default` (a single-export helper) or
 * named exports (ajv-formats' format tables).
 */
function asModuleExports(imported: unknown): Record<string, unknown> {
  return typeof imported === "function"
    ? ({ __esModule: true, default: imported } as Record<string, unknown>)
    : (imported as Record<string, unknown>);
}

/**
 * What the kernel publishes, in the order a shim tree is written.
 *
 * The ajv entries are imported statically, so a bundled kernel carries them: a
 * validator compiled by this kernel names them, and `require`-ing them off disk
 * is precisely what fails when there is no ajv on disk to find.
 */
const ENTRIES: ReadonlyArray<RealmEntry> = [
  { specifier: "@telorun/sdk", format: "esm", module: sdk as unknown as Record<string, unknown> },
  ...([
    ["ajv/dist/runtime/equal.js", ajvEqual],
    ["ajv/dist/runtime/parseJson.js", ajvParseJson],
    ["ajv/dist/runtime/quote.js", ajvQuote],
    ["ajv/dist/runtime/timestamp.js", ajvTimestamp],
    ["ajv/dist/runtime/ucs2length.js", ajvUcs2length],
    ["ajv/dist/runtime/uri.js", ajvUri],
    ["ajv/dist/runtime/validation_error.js", ajvValidationError],
    ["ajv-formats/dist/formats.js", ajvFormats],
  ] as ReadonlyArray<[string, unknown]>).map(([specifier, module]) => ({
    specifier,
    format: "cjs" as const,
    module: asModuleExports(module),
  })),
];

/** The realm names a controller bundle imports, which are the ones that need a
 *  generated package on disk: the bundle is loaded by the runtime's own
 *  resolution, which the kernel cannot intercept portably. The ajv half is
 *  served in-process instead (`realmRequire`), because the kernel supplies the
 *  `require` a compiled validator runs with. */
const BUNDLE_ENTRIES = ENTRIES.filter((entry) => entry.format === "esm");

/**
 * Publish this kernel's instances into the process, once.
 *
 * Entries are overwritten rather than kept, which is deliberate: the SDK is one
 * scope per process, so a second kernel in the same process is publishing the
 * same objects, and a stale first writer would otherwise pin an older ajv for
 * everyone.
 */
function registry(): Map<string, unknown> {
  const global = globalThis as Record<symbol, unknown>;
  let table = global[REALM_KEY] as Map<string, unknown> | undefined;
  if (!table) {
    table = new Map<string, unknown>();
    global[REALM_KEY] = table;
  }
  for (const entry of ENTRIES) table.set(entry.specifier, entry.module);
  return table;
}
registry();

/** What a shim says when it is imported in a process with no kernel — a stray
 *  bundle run by hand, or a cache directory copied somewhere else. Naming the
 *  cause is the whole point: the alternative resolves to an empty module and
 *  fails later as an undefined property. */
const NO_HOST =
  'throw new Error("telo: @telorun/sdk resolved to a realm shim, but no Telo kernel is running in this process. A controller bundle is only loadable by the kernel that wrote this directory.");';

/** The ESM shim source: one re-export per name the running kernel exports,
 *  sorted so the file is stable between runs and only rewritten when the SDK's
 *  surface actually changes. Names are emitted as string export specifiers, so
 *  one that is not a JavaScript identifier cannot break the file. */
const shimSources = new WeakMap<Record<string, unknown>, string>();
function esmShimSource(specifier: string, module: Record<string, unknown>): string {
  // Once per published module rather than once per bundle directory: every
  // module's bundle directory gets the same shim.
  let source = shimSources.get(module);
  if (source === undefined) {
    source = buildEsmShimSource(specifier, module);
    shimSources.set(module, source);
  }
  return source;
}

function buildEsmShimSource(specifier: string, module: Record<string, unknown>): string {
  const names = Object.keys(module)
    .filter((name) => name !== "default")
    .sort();
  const lines = [
    `const realm = globalThis[Symbol.for("telo.realm")];`,
    `const host = realm && realm.get(${JSON.stringify(specifier)});`,
    `if (!host) { ${NO_HOST} }`,
    ...names.map(
      (name, index) =>
        `const v${index} = host[${JSON.stringify(name)}]; export { v${index} as ${JSON.stringify(name)} };`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Make every realm name a controller bundle may import resolve, from `dir`.
 *
 * Idempotent and content-checked, so a directory shared between kernel versions
 * converges on the running kernel's surface instead of keeping the first
 * writer's.
 *
 * **A directory is remembered only when nothing was left undone.** What this
 * mechanism fails into is two SDK instances in one process — every `instanceof`
 * across the controller boundary false — or a bare `ERR_MODULE_NOT_FOUND` on a
 * read-only mount, neither of which says why. So a write that fails is reported
 * and NOT remembered: a later load of the same directory tries again, which is
 * what makes a transient failure transient. A slot an installer owns is
 * reported too, but is settled — nothing this kernel does will change it.
 */
const preparedBundleDirs = new Set<string>();
export async function ensureRealmShims(
  dir: string,
  cacheRoot: string | undefined,
  log?: Logger,
): Promise<void> {
  if (preparedBundleDirs.has(dir)) return;
  if (await writeShims(dir, BUNDLE_ENTRIES, cacheRoot, log)) preparedBundleDirs.add(dir);
}

/**
 * Serve a realm name to code the kernel loads itself.
 *
 * A compiled validator is read off disk and evaluated with a `require` the
 * kernel supplies, so its ajv imports are answered here rather than through a
 * generated package: nothing is written, and the helpers are the very ones this
 * kernel validates with. Returns `undefined` for a name the realm does not
 * carry, leaving the caller's own resolution to answer.
 *
 * A validator names its imports without the `.js` the registry keys carry, so
 * both spellings resolve.
 */
export function realmRequire(specifier: string): unknown {
  const table = registry();
  return table.get(specifier) ?? table.get(`${specifier}.js`);
}

/** Writes every entry's generated package. Returns whether the directory is
 *  settled — every entry either landed or belongs to someone else. */
async function writeShims(
  dir: string,
  entries: ReadonlyArray<RealmEntry>,
  cacheRoot: string | undefined,
  log?: Logger,
): Promise<boolean> {
  const table = registry();
  let settled = true;
  for (const entry of entries) {
    const host = table.get(entry.specifier) as Record<string, unknown> | undefined;
    if (!host) {
      // The kernel did not publish this name, so nothing can resolve it. Not
      // recoverable by retrying, and the bundle's import is about to fail.
      log?.warn("realm name is not published by this kernel", {
        "telo.realm.specifier": entry.specifier,
        "telo.realm.slot": dir,
      });
      continue;
    }
    const packageDir = path.join(dir, "node_modules", ...entry.specifier.split("/"));
    if (!(await isWritableShimSlot(packageDir, cacheRoot))) {
      // Someone else's package resolves the name to real code; what is lost is
      // the single-scope property, which is exactly the sibling-library slot
      // rule and is reported the same way.
      log?.debug("left an existing package in a realm slot", {
        "telo.realm.specifier": entry.specifier,
        "telo.realm.slot": packageDir,
      });
      continue;
    }
    try {
      await clearLinkedSlot(packageDir);
      await writeIfChanged(
        path.join(packageDir, "package.json"),
        shimPackageJson(entry.specifier, "realm-shim", "./index.mjs"),
      );
      await writeIfChanged(path.join(packageDir, "index.mjs"), esmShimSource(entry.specifier, host));
    } catch (err) {
      // A read-only mount, or a race with another kernel populating the same
      // cache directory. Reported rather than swallowed: the import that
      // follows fails with a resolution error naming nothing about this.
      settled = false;
      log?.warn(
        "could not write a realm shim; the controller's import of this name will fail",
        { "telo.realm.specifier": entry.specifier, "telo.realm.slot": packageDir },
        { error: err },
      );
    }
  }
  return settled;
}
