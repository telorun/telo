import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { REALM_COLLAPSE_NAMES } from "./realm.js";

/**
 * Transparent controller bundling: collapse a controller's loose `node_modules`
 * dependency tree into one esbuild bundle so cold-start import reads a single
 * file instead of hundreds of small ones (the k8s cold-FS latency this targets).
 *
 * The PURL never changes — bundling is a load-time cache over npm resolution, not
 * a delivery format. {@link tryBuildControllerBundle} is a pure accelerator: it
 * returns a bundle path on success, or `null` (→ caller imports the loose entry)
 * whenever bundling can't or shouldn't run, and never throws.
 *
 * The bundle is written **next to its entry file** (inside the package), so its
 * externalized bare imports (`@telorun/sdk`, native packages like
 * `better-sqlite3`) resolve at runtime through the exact same `node_modules`
 * walk-up the loose entry would — wherever the dep is hoisted or nested.
 *
 * On by default; `TELO_CONTROLLER_BUNDLE=0` (or false/no/off) is a kill-switch
 * that forces loose imports. Safe to leave on: it applies only to real (copied)
 * installs — symlinked `local_path` dev installs are skipped — and any build
 * failure falls back to the loose import.
 */
const BUNDLE_PREFIX = ".telobundle.";

function bundlingEnabled(): boolean {
  const v = process.env.TELO_CONTROLLER_BUNDLE?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const typeModuleCache = new Map<string, boolean>();

/** Whether `entryFile` is an ES module: `.mjs` / non-`.js` (e.g. `.ts`) yes,
 *  `.cjs` no, `.js` per the nearest `package.json` `"type"`. */
async function isEsmEntry(entryFile: string): Promise<boolean> {
  const ext = path.extname(entryFile).toLowerCase();
  if (ext === ".mjs") return true;
  if (ext === ".cjs") return false;
  if (ext !== ".js") return true; // .ts and friends — authored as ESM
  const dir = path.dirname(entryFile);
  const cached = typeModuleCache.get(dir);
  if (cached !== undefined) return cached;
  let isModule = false;
  let d = dir;
  for (;;) {
    const pj = path.join(d, "package.json");
    if (await pathExists(pj)) {
      try {
        isModule = JSON.parse(await fs.readFile(pj, "utf8")).type === "module";
      } catch {
        /* unreadable package.json → treat as CJS (skip bundling) */
      }
      break;
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  typeModuleCache.set(dir, isModule);
  return isModule;
}

/** Memoized esbuild handle: `undefined` until first tried, `null` when absent.
 *  A failed dynamic import isn't reliably cached by Node, so without this every
 *  controller load would re-attempt (and re-fail) the import. */
let esbuildModule: typeof import("esbuild") | null | undefined;
async function loadEsbuild(): Promise<typeof import("esbuild") | null> {
  if (esbuildModule !== undefined) return esbuildModule;
  try {
    esbuildModule = await import("esbuild");
  } catch {
    esbuildModule = null;
  }
  return esbuildModule;
}

/**
 * Build — or reuse a cached — single-file bundle of `entryFile`, written beside
 * the entry inside the installed package so the bundle's externalized bare
 * imports (`@telorun/sdk`, native packages) resolve through the entry's own
 * `node_modules` walk-up. Built from the pinned `name@version` package, so the
 * same controller yields the same bundle in every environment — parity by
 * construction.
 *
 * Returns `null` (caller falls back to the loose entry import) when: bundling is
 * disabled, the install is a symlinked source checkout, esbuild isn't installed,
 * the package dir is read-only (baked runtime), or the build fails (an
 * unbundleable controller).
 */
export async function tryBuildControllerBundle(
  installRoot: string,
  entryFile: string,
): Promise<string | null> {
  if (!bundlingEnabled()) return null;

  // Only bundle a *real* install (the package physically copied under the install
  // root). A `local_path` / `file:` dep is symlinked to its source checkout, so
  // its entry's realpath escapes the install root — writing "next to the entry"
  // there would land bundles in the committed source tree. Dev runs that way
  // simply skip bundling (loose import); the production bake is a real install.
  const realEntry = await realpathOrNull(entryFile);
  const realRoot = await realpathOrNull(installRoot);
  if (!realEntry || !realRoot || !isUnder(realEntry, realRoot)) return null;

  // Only bundle ESM entries. esbuild's ESM output preserves named exports, so a
  // bundled ESM controller has the same `create`/`register` shape as the loose
  // one. A CJS entry, by contrast, bundles to `{ default }` only (esbuild does
  // not lift CJS named exports), which the loader would reject — so skip it and
  // let the loose import (where Node synthesizes the named exports) handle it.
  if (!(await isEsmEntry(realEntry))) return null;

  // Beside the entry, so the bundle's externalized imports resolve through the
  // entry's own node_modules walk-up (native deps may be nested under the
  // controller package, not hoisted to the install root).
  const bundleFile = path.join(
    path.dirname(realEntry),
    `${BUNDLE_PREFIX}${sanitize(path.basename(realEntry))}.mjs`,
  );

  if (await usableCachedBundle(bundleFile)) return bundleFile;

  // Single-flight per bundle file within the process: a test run spawns many
  // kernels sharing one install root, so concurrent loads of the same controller
  // would otherwise each launch an esbuild over the same output.
  const inFlight = buildsInFlight.get(bundleFile);
  if (inFlight) return inFlight;
  const work = buildBundle(bundleFile, entryFile).finally(() =>
    buildsInFlight.delete(bundleFile),
  );
  buildsInFlight.set(bundleFile, work);
  return work;
}

const buildsInFlight = new Map<string, Promise<string | null>>();
let tmpCounter = 0;

/** A bundle that anchors path resolution to its own directory (esbuild rewrites
 *  `__dirname`/`__filename` to `import.meta.url`) can't be safely relocated. */
const DIR_RELATIVE = /import\.meta\.url|\b__dirname\b|\b__filename\b/;

/** A cached bundle is usable only when its `.ok` sidecar is present — written
 *  once after the build passed the safety guard. Checking the marker (two stats)
 *  avoids re-reading the whole bundle on every load. A bundle without its marker
 *  (written before the guard existed, a torn write, or a failed build) self-heals
 *  to the loose import and is cleared on a writable FS. */
async function usableCachedBundle(bundleFile: string): Promise<boolean> {
  if ((await pathExists(okMarker(bundleFile))) && (await pathExists(bundleFile))) return true;
  await fs.rm(bundleFile, { force: true }).catch(() => {});
  await fs.rm(okMarker(bundleFile), { force: true }).catch(() => {});
  return false;
}

function okMarker(bundleFile: string): string {
  return `${bundleFile}.ok`;
}

async function buildBundle(bundleFile: string, entryFile: string): Promise<string | null> {
  if (await usableCachedBundle(bundleFile)) return bundleFile;

  const esbuild = await loadEsbuild();
  if (!esbuild) return null; // esbuild not installed → loose import

  // Build in memory, then write to a unique temp and atomically rename into
  // place — so a cross-process race never leaves a half-written bundle for a
  // concurrent reader (or a concurrent build) to import.
  const tmpFile = `${bundleFile}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    const result = await esbuild.build({
      entryPoints: [entryFile],
      outfile: bundleFile,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      write: false,
      plugins: [nativeExternalsPlugin()],
    });
    const out = result.outputFiles?.[0];
    if (!out) return null;
    // A flattened bundle that resolves paths relative to its own directory is
    // unsafe: a deep dep locating a sibling asset (e.g. http-server's
    // `${__dirname}/js/standalone.js`) would miss it at the bundle's new
    // location. esbuild rewrites `__dirname`/`__filename` to `import.meta.url`,
    // so its presence flags this — fall back to the loose import for those.
    if (DIR_RELATIVE.test(out.text)) {
      if (process.env.TELO_BUNDLE_DEBUG) {
        process.stderr.write(`[bundle] skipped ${entryFile}: directory-relative asset resolution\n`);
      }
      return null;
    }
    await fs.writeFile(tmpFile, out.contents);
    await fs.rename(tmpFile, bundleFile);
    // Marker written last: its presence means "this bundle built and passed the
    // safety guard", so cache hits trust it without re-reading the bundle.
    await fs.writeFile(okMarker(bundleFile), "").catch(() => {});
    return bundleFile;
  } catch (err) {
    if (process.env.TELO_BUNDLE_DEBUG) {
      process.stderr.write(
        `[bundle] skipped ${entryFile}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`,
      );
    }
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    return null; // unbundleable controller → loose import
  }
}

/**
 * esbuild plugin deciding which bare imports stay external rather than inline:
 *  - `@telorun/*` framework packages — the shared runtime (incl. the realm
 *    `@telorun/sdk`, whose `Stream`/`InvokeError` identity must be the kernel's
 *    copy); inlining them is both wrong (duplicates the runtime per controller)
 *    and impossible (the kernel pulls in esbuild's unbundleable API);
 *  - `esbuild` — a build tool, never part of a controller;
 *  - native packages — ship a `.node` and can't be inlined;
 *  - packages not present in the install (optional deps like `pg-native`) —
 *    externalized so the build succeeds and the runtime require behaves exactly
 *    as it would loose (the controller's own try/catch handles the absence).
 * Everything else (the controller's own files + third-party JS) inlines.
 */
function nativeExternalsPlugin(): import("esbuild").Plugin {
  const realm = new Set(REALM_COLLAPSE_NAMES);
  const decided = new Map<string, boolean>();
  return {
    name: "telo-native-externals",
    setup(build) {
      // A direct `.node` binary import can never be bundled.
      build.onResolve({ filter: /\.node$/ }, () => ({ external: true }));
      // Bare specifiers only (paths starting with `.` or `/` are relative/absolute).
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (path.isAbsolute(args.path)) return null;
        const top = topPackage(args.path);
        // Realm names (the identity-critical set realm.ts owns) plus the rest of
        // the `@telorun/*` framework and esbuild itself — never inline these.
        if (realm.has(top) || top.startsWith("@telorun/") || top === "esbuild") {
          return { external: true };
        }
        const pkgDir = findPackageDir(top, args.resolveDir);
        if (!pkgDir) return { external: true }; // missing/optional dep → behave as loose
        let isNative = decided.get(pkgDir);
        if (isNative === undefined) {
          isNative = await detectNative(pkgDir);
          decided.set(pkgDir, isNative);
        }
        return isNative ? { external: true } : null;
      });
    },
  };
}

/** Top-level package of a bare specifier: `@scope/x/y` → `@scope/x`, `a/b` → `a`. */
function topPackage(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Nearest `node_modules/<pkgName>` walking up from `fromDir`, or null. */
function findPackageDir(pkgName: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...pkgName.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A package is native if it ships prebuilt binaries / a build output, or its
 *  manifest declares a node-gyp / prebuild-style native build. */
async function detectNative(pkgDir: string): Promise<boolean> {
  if (await pathExists(path.join(pkgDir, "prebuilds"))) return true;
  if (await pathExists(path.join(pkgDir, "build", "Release"))) return true;
  try {
    const pj = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
    if (pj.gypfile || pj.binary) return true;
    const scripts = pj.scripts ?? {};
    const installish = `${scripts.preinstall ?? ""} ${scripts.install ?? ""} ${scripts.postinstall ?? ""}`;
    if (/node-gyp|prebuild-install|node-pre-gyp|node-gyp-build|cmake-js/.test(installish)) return true;
  } catch {
    // unreadable package.json — treat as non-native; esbuild surfaces real errors
  }
  return false;
}
