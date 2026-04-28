import { ControllerInstance, RuntimeError } from "@telorun/sdk";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import { createRequire } from "module";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

/**
 * Recoverable resolution failure — the loader could not find the artifact in the
 * environment (missing rustc, missing local_path, missing prebuilt dylib in dist
 * mode). The dispatcher may try the next candidate when wildcard fallback is
 * enabled. Distinguished from `RuntimeError("ERR_CONTROLLER_BUILD_FAILED" | …)`
 * which is non-recoverable: those mean user code is broken and must surface.
 */
export class ControllerEnvMissingError extends Error {
  readonly _envMissing = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ControllerEnvMissingError";
  }
}

/**
 * Process-lifetime cache of resolved native modules keyed by the realpath of
 * the crate directory. The first call for a given crate does the cargo build,
 * dylib rename, and `require()` work; subsequent calls (e.g. a second kernel
 * registering the same controller, or two manifests reaching the crate via
 * different — possibly symlinked — paths) skip straight to the cached module.
 *
 * Beyond the obvious cost saving, this is load-bearing for Node compatibility:
 * `fs.copyFile` overwriting a `.node` file that Node has already mmapped, plus
 * the secondary `cargo metadata` / build invocations, can leave Node's native
 * addon machinery in a state where finalize callbacks for class instances
 * created in a previous kernel race and segfault. Keying on the canonical
 * crate path (not on the caller's baseUri) ensures two distinct paths that
 * point at the same crate share one cache entry.
 */
/**
 * Holds the *raw* `require()`'d module object — i.e. the flat export bag
 * returned by the napi addon — keyed by canonical crate path. The PURL
 * fragment (`#entry`) projects out a sub-export at call time; caching the
 * raw module here means two PURLs that differ only by fragment share one
 * cargo build / one mmap of the dylib, instead of paying for either twice.
 */
const _napiModuleCache = new Map<string, any>();

interface BuildAndLoadResult {
  rawModule: any;
  nodePath: string;
}

/**
 * Single-flight dedupe for concurrent loads of the same crate. Without this,
 * two callers (e.g. parallel test kernels) both miss the module cache, both
 * run cargo + `fs.copyFile` over the same `.node` file, and the second
 * `copyFile` overwrites a dylib Node has already mmapped — leading to a
 * segfault when napi finalize callbacks run against torn pages. Keeping the
 * in-flight promise here lets late arrivals await the in-progress load and
 * read from the populated module cache when it resolves.
 */
const _napiInFlight = new Map<string, Promise<BuildAndLoadResult>>();

/**
 * @internal Slow-path entry counter — the regression test for concurrent
 * loads asserts this stays at 1 across N parallel callers, proving the
 * single-flight gate held. Production code never reads it.
 */
let _napiBuildAttempts = 0;
export function __getNapiBuildAttempts(): number {
  return _napiBuildAttempts;
}
export function __resetNapiLoaderForTest(): void {
  _napiBuildAttempts = 0;
  _napiModuleCache.clear();
  _napiInFlight.clear();
}

/**
 * Which branch of the resolver served this load.
 *
 * - `cache`      — process-lifetime in-memory hit on `_napiModuleCache`.
 * - `local`      — `local_path` qualifier; cargo was invoked but the work
 *                  is conceptually equivalent to "found source on disk and
 *                  used it" (parallel to the npm `local_path` branch). The
 *                  CLI silences these by default; the first cold build on
 *                  a fresh checkout is silent for the same reason.
 * - `cargo-build`— reserved for distribution-mode resolution (fetch from a
 *                  registry + compile). Not produced today; the dispatcher
 *                  errors with `ControllerEnvMissingError` for non-local
 *                  PURLs (see [napi-loader.ts:62-66] in this file).
 */
export type NapiResolveSource = "cache" | "local" | "cargo-build";

export interface NapiLoadResult {
  instance: ControllerInstance;
  source: NapiResolveSource;
}

export class NapiControllerLoader {
  /**
   * Resolve a `pkg:cargo/...` PURL to a controller module instance by building
   * the crate and loading the resulting native addon.
   *
   * Dev mode (local_path qualifier present): probe rustc, run `cargo build
   * --release`, locate the dylib via `cargo metadata`, copy to
   * `<libname>.node`, load via createRequire. Cached on success.
   *
   * Distribution mode (no local_path): out of scope for the PoC; the hook is
   * left in place so the dispatcher reports env-missing and falls through.
   *
   * Fragment (`#entry`) is optional. When absent, the whole `require()`'d
   * module is returned as the controller — the legacy single-export
   * convention. When present, the fragment is treated as a property name on
   * the loaded module: e.g. `pkg:cargo/foo?local_path=...#bar` returns
   * `module.bar` as the controller. This mirrors the npm `#entry` semantics
   * but indexes into the flat napi export bag instead of opening a different
   * file. The convention is "one source file per controller, top-level
   * export name matches the file" — files-as-controllers in spirit, even
   * though all exports come from one linked dylib.
   */
  async load(purl: string, baseUri: string): Promise<NapiLoadResult> {
    const [, , name, , qualifiers, entry] = PackageURL.parseString(purl);
    const localPath = (qualifiers as any)?.get("local_path");

    const isLocalManifest =
      baseUri && !baseUri.startsWith("http://") && !baseUri.startsWith("https://");
    if (!localPath || !isLocalManifest) {
      throw new ControllerEnvMissingError(
        `pkg:cargo distribution-mode resolution is not implemented for the PoC; supply ?local_path=...`,
      );
    }

    const baseUriPath = baseUri.startsWith("file://") ? baseUri.slice("file://".length) : baseUri;
    const manifestDir = path.dirname(baseUriPath);
    const cratePath = path.resolve(manifestDir, localPath);

    if (!(await pathExists(cratePath))) {
      throw new ControllerEnvMissingError(`pkg:cargo local_path does not exist: ${cratePath}`);
    }

    // Key the cache on the canonical crate location (realpath) — two manifests
    // that reach the same crate via different baseUris (e.g. through symlinked
    // workspace paths) must share one cache entry. A miss here would re-run
    // cargo build and `fs.copyFile` over an already-mmapped `.node`, which
    // can leave napi finalize callbacks racing and crash Node.
    const canonicalCratePath = await fs.realpath(cratePath);
    const cacheKey = canonicalCratePath;
    const cached = _napiModuleCache.get(cacheKey);
    if (cached) {
      return { instance: project(cached, entry, cratePath), source: "cache" };
    }

    // Concurrent callers for the same crate await one shared build. They
    // report `local` (not `cache`): they paid the same wall-clock cost as
    // the originator, just by sharing one cargo invocation rather than
    // running their own. Reporting `cache` here would mislead metrics/event
    // consumers into thinking it was a sub-ms hit.
    const existingInFlight = _napiInFlight.get(cacheKey);
    if (existingInFlight) {
      const { rawModule } = await existingInFlight;
      return { instance: project(rawModule, entry, cratePath), source: "local" };
    }

    const buildPromise = this.buildAndLoad(cratePath, name ?? "", cacheKey);
    _napiInFlight.set(cacheKey, buildPromise);
    let rawModule: any;
    let nodePath: string;
    try {
      ({ rawModule, nodePath } = await buildPromise);
    } finally {
      _napiInFlight.delete(cacheKey);
    }
    // `local` rather than `cargo-build` because the only mode currently
    // wired up is `local_path` dev-mode — cargo's incremental cache means
    // every run after the first is ~50ms of cargo-startup with no real
    // compilation, conceptually the same as the npm `local_path` branch
    // that just imports source already on disk. Distribution mode (when
    // implemented) will return `cargo-build` from its own branch.
    return { instance: project(rawModule, entry, nodePath), source: "local" };
  }

  private async buildAndLoad(
    cratePath: string,
    fallbackName: string,
    cacheKey: string,
  ): Promise<BuildAndLoadResult> {
    _napiBuildAttempts++;
    try {
      await execFileAsync("rustc", ["--version"]);
    } catch {
      throw new ControllerEnvMissingError("rustc not found on PATH");
    }

    try {
      // Plain `cargo build --release` — no `--features` flag. The SDK's
      // `default = ["napi"]` selects the napi backend transitively, so the
      // controller crate's Cargo.toml stays free of any `[features]` block
      // or napi-rs deps. A future Rust kernel passes
      // `--no-default-features --features native` here instead.
      await execFileAsync("cargo", ["build", "--release"], {
        cwd: cratePath,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err: any) {
      const stderr = err?.stderr ? `\n${err.stderr}` : "";
      throw new RuntimeError(
        "ERR_CONTROLLER_BUILD_FAILED",
        `cargo build failed for ${cratePath}:${stderr}`,
      );
    }

    const { targetDir, libName } = await resolveCrateMetadata(cratePath, fallbackName);

    const dylibPath = await findDylib(targetDir, libName);
    if (!dylibPath) {
      throw new RuntimeError(
        "ERR_CONTROLLER_BUILD_FAILED",
        `cargo build succeeded but no cdylib found for ${libName} under ${path.join(targetDir, "release")}/`,
      );
    }

    const nodePath = path.join(path.dirname(dylibPath), `${libName}.node`);
    await fs.copyFile(dylibPath, nodePath);

    let rawModule: any;
    try {
      rawModule = requireFromHere(nodePath);
    } catch (err: any) {
      throw new RuntimeError(
        "ERR_CONTROLLER_INVALID",
        `Failed to load native addon ${nodePath}: ${err.message}`,
      );
    }

    _napiModuleCache.set(cacheKey, rawModule);
    return { rawModule, nodePath };
  }
}

/**
 * Pick the controller out of the raw napi module. With no fragment, the
 * whole module *is* the controller (legacy single-export shape). With a
 * fragment, look up `module[entry]` — convention: one source file per
 * controller, top-level export name matches the file.
 */
function project(module: any, entry: string | undefined, where: string): ControllerInstance {
  if (!module) {
    throw new RuntimeError("ERR_CONTROLLER_INVALID", `napi module from ${where} is empty`);
  }
  if (!entry) {
    if (!module.create && !module.register) {
      throw new RuntimeError(
        "ERR_CONTROLLER_INVALID",
        `pkg:cargo controller at ${where} exports neither create nor register`,
      );
    }
    return module;
  }
  const sub = module[entry];
  if (!sub) {
    throw new RuntimeError(
      "ERR_CONTROLLER_INVALID",
      `pkg:cargo controller at ${where}#${entry}: module has no export named "${entry}"`,
    );
  }
  if (!sub.create && !sub.register) {
    throw new RuntimeError(
      "ERR_CONTROLLER_INVALID",
      `pkg:cargo controller at ${where}#${entry} exports neither create nor register`,
    );
  }
  return sub;
}

async function resolveCrateMetadata(
  cratePath: string,
  fallbackName: string,
): Promise<{ targetDir: string; libName: string }> {
  const result = await execFileAsync("cargo", [
    "metadata",
    "--format-version",
    "1",
    "--manifest-path",
    path.join(cratePath, "Cargo.toml"),
    "--no-deps",
  ], { maxBuffer: 32 * 1024 * 1024 });
  const metadata = JSON.parse(result.stdout);
  const cratePackage = metadata.packages?.find(
    (p: any) => p.manifest_path === path.join(cratePath, "Cargo.toml"),
  );
  const packageName = cratePackage?.name ?? fallbackName;
  return {
    targetDir: metadata.target_directory,
    libName: packageName.replace(/-/g, "_"),
  };
}

async function findDylib(targetDir: string, libName: string): Promise<string | null> {
  const releaseDir = path.join(targetDir, "release");
  const candidates = [
    path.join(releaseDir, `lib${libName}.so`),
    path.join(releaseDir, `lib${libName}.dylib`),
    path.join(releaseDir, `${libName}.dll`),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
