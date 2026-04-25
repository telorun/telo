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
const _napiModuleCache = new Map<string, ControllerInstance>();

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
   */
  async load(purl: string, baseUri: string): Promise<ControllerInstance> {
    const [, , name, , qualifiers] = PackageURL.parseString(purl);
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
      return cached;
    }

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

    const { targetDir, libName } = await resolveCrateMetadata(cratePath, name ?? "");

    const dylibPath = await findDylib(targetDir, libName);
    if (!dylibPath) {
      throw new RuntimeError(
        "ERR_CONTROLLER_BUILD_FAILED",
        `cargo build succeeded but no cdylib found for ${libName} under ${path.join(targetDir, "release")}/`,
      );
    }

    const nodePath = path.join(path.dirname(dylibPath), `${libName}.node`);
    await fs.copyFile(dylibPath, nodePath);

    let module: any;
    try {
      module = requireFromHere(nodePath);
    } catch (err: any) {
      throw new RuntimeError(
        "ERR_CONTROLLER_INVALID",
        `Failed to load native addon ${nodePath}: ${err.message}`,
      );
    }

    if (!module || (!module.create && !module.register)) {
      throw new RuntimeError(
        "ERR_CONTROLLER_INVALID",
        `pkg:cargo controller at ${nodePath} exports neither create nor register`,
      );
    }
    _napiModuleCache.set(cacheKey, module);
    return module;
  }
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
