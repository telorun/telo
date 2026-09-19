import { resolveCacheRoot, setEsbuildExecutableProvider } from "@telorun/kernel";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";
import { bakedVersion } from "../distribution-versions.js";

/**
 * What the standalone binary has to arrange that an installed CLI gets for
 * free.
 *
 * The binary is one file: the CLI, the kernel and everything they import are
 * compiled into it, and there is no `node_modules` beside it. Two things cannot
 * be compiled in, and each is handled where it is needed rather than up front:
 *
 *  - **esbuild's executable.** The JavaScript API is inside the binary, but the
 *    compiler it drives is a native program, so it rides along as an embedded
 *    asset and is unpacked to the telo cache the first time a controller is
 *    actually built from source. A run that loads only published modules never
 *    unpacks it.
 *  - **The SDK a controller imports**, which the kernel's realm answers from
 *    the copy inside the binary. That needs nothing here — it is the kernel's
 *    own mechanism and works the same in every distribution.
 *
 * Nothing is unpacked eagerly at startup: `telo check` on a manifest of
 * published modules should touch no disk beyond the caches it already uses.
 */

/** The embedded asset key the build writes esbuild's executable under. */
const ESBUILD_ASSET = "esbuild";

/** Whether this process is a single-file executable. `node:sea` is loaded
 *  through `createRequire` because it has no ESM shape, and lazily because its
 *  absence answers the question too: a Node old enough not to carry it cannot
 *  be running a single-file executable. */
function seaModule(): { isSea(): boolean; getRawAsset(key: string): ArrayBuffer } | undefined {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as {
      isSea(): boolean;
      getRawAsset(key: string): ArrayBuffer;
    };
    return sea.isSea() ? sea : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register what a single-file executable has to supply. A no-op in every other
 * distribution, so the ordinary entry point calls it unconditionally.
 */
export function installStandaloneRuntime(): void {
  const sea = seaModule();
  if (!sea) return;
  setEsbuildExecutableProvider(async () => unpackEsbuild(sea));
}

/**
 * Write the embedded esbuild executable to the telo cache and return its path.
 *
 * Keyed by the version the binary carries, so a cache shared by two telo
 * versions holds one file each rather than one file whose contents depend on
 * who wrote it last. Written through a temp file and renamed, because a second
 * telo may be unpacking the same path at the same time and a half-written
 * executable is one a build would try to run.
 */
async function unpackEsbuild(sea: {
  getRawAsset(key: string): ArrayBuffer;
}): Promise<string | undefined> {
  const cacheRoot = resolveCacheRoot(process.cwd());
  if (!cacheRoot) return undefined;
  // Keyed on the version baked at build time. Without a real key every telo
  // that ever ran here shares one path, and the first writer's executable is
  // driven by every later binary's inlined API — which esbuild refuses as a
  // host/binary mismatch. A build that cannot state the version writes no
  // cache entry at all, the same rule the kernel's caches take.
  const version = bakedVersion("esbuild");
  if (!version) return undefined;
  const target = path.join(
    cacheRoot,
    "tools",
    `esbuild-${version}`,
    process.platform === "win32" ? "esbuild.exe" : "esbuild",
  );
  try {
    if (fs.existsSync(target)) return target;
    const bytes = Buffer.from(sea.getRawAsset(ESBUILD_ASSET));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o755 });
    fs.renameSync(tmp, target);
    return target;
  } catch {
    // No writable cache, or the asset is absent from this build. The kernel
    // then reports esbuild as unavailable, which selects a prebuilt controller
    // where one exists and says so where one does not.
    return undefined;
  }
}
