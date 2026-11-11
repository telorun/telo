import { DESKTOP_HELPER_HOST_VALUE } from "@telorun/kernel";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { userCacheRoot, writableDir } from "../package/app-home.js";
import { cliVersion, distributionKind } from "../distribution-versions.js";
import { hostReleaseTarget, releaseAsset, ReleaseBinaryError, type ReleaseBinaryOptions } from "../release-binary.js";
import { DesktopHostUnavailable } from "./desktop-host-unavailable.js";

/**
 * Where the `telo-desktop-host` helper binary comes from, first answer wins:
 *
 * 1. `TELO_HOST_DESKTOP_HELPER`, an absolute path used as it is (a test and
 *    development seam; hidden from controllers like every host value);
 * 2. the packaged app's own copy (`packagedHelperPath`, which the packager's
 *    carrier supplies — a packaged app runs offline);
 * 3. a source checkout: built with cargo, `--features gui`, from the crate;
 * 4. the release the CLI belongs to: `telo-desktop-host-<version>-<os>-<arch>[-<libc>]`,
 *    verified against that release's `checksums.txt` (the fetch `telo package`
 *    shares) and cached under the user cache.
 *
 * Every failure is `ERR_DESKTOP_HOST_UNAVAILABLE`, never a fallthrough to the
 * next source: a source that was chosen and broke is what the user must hear.
 */

const run = promisify(execFile);

const CRATE = "telo-desktop-host";

export interface HelperLocationOptions {
  env?: NodeJS.ProcessEnv;
  /** The helper a packaged app carries, when this is one. */
  packagedHelperPath?: string | null;
  /** The source checkout this CLI runs from, when it does (`detectCheckout`). */
  checkout?: { root: string } | null;
  /** Builds the helper in a checkout; `cargo build --release --features gui -p telo-desktop-host` by default. */
  buildInCheckout?: (root: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** The CLI's version: the release the download comes from, and the version the helper must report. */
  version?: string;
  /** This machine's release-asset target (`linux-amd64-gnu`). */
  target?: string | null;
  /** `<cache root>/desktop-host` by default. */
  cacheRoot?: string | null;
  fetch?: ReleaseBinaryOptions["fetch"];
  report?: (message: string) => void;
  platform?: NodeJS.Platform;
}

export function helperAssetName(version: string, target: string): string {
  return `${CRATE}-${version}-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
}

export async function locateHelper(options: HelperLocationOptions = {}): Promise<string> {
  const env = options.env ?? process.env;

  const fromEnv = env[DESKTOP_HELPER_HOST_VALUE]?.trim();
  if (fromEnv) {
    if (!path.isAbsolute(fromEnv) || !isFile(fromEnv)) {
      throw new DesktopHostUnavailable(`${DESKTOP_HELPER_HOST_VALUE} names ${fromEnv}, which is not an absolute path to a file`);
    }
    return fromEnv;
  }

  if (options.packagedHelperPath) {
    if (!isFile(options.packagedHelperPath)) {
      throw new DesktopHostUnavailable(`the helper this application carries is missing (${options.packagedHelperPath})`);
    }
    return options.packagedHelperPath;
  }

  if (options.checkout) return buildAndLocate(options.checkout.root, env, options);

  return download(options, env);
}

async function buildAndLocate(root: string, env: NodeJS.ProcessEnv, options: HelperLocationOptions): Promise<string> {
  options.report?.(`building ${CRATE} with cargo`);
  try {
    await (options.buildInCheckout ?? cargoBuild)(root, env);
  } catch (err) {
    throw new DesktopHostUnavailable(`building ${CRATE} with cargo failed: ${(err as Error).message}`);
  }
  const exe = (options.platform ?? process.platform) === "win32" ? ".exe" : "";
  const targetDir = env.CARGO_TARGET_DIR?.trim() ? path.resolve(env.CARGO_TARGET_DIR) : path.join(root, "target");
  const built = path.join(targetDir, "release", `${CRATE}${exe}`);
  if (!isFile(built)) throw new DesktopHostUnavailable(`cargo built no ${built}`);
  return built;
}

async function cargoBuild(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await run("cargo", ["build", "--release", "--features", "gui", "-p", CRATE], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim().split("\n").slice(-5).join("\n");
    throw new Error(stderr || (err as Error).message);
  }
}

async function download(options: HelperLocationOptions, env: NodeJS.ProcessEnv): Promise<string> {
  const version = options.version ?? cliVersion();
  if (!version) throw new DesktopHostUnavailable("this telo does not know its own version, so it cannot name the helper to download");
  const target = options.target === undefined ? hostReleaseTarget() : options.target;
  if (!target) {
    throw new DesktopHostUnavailable(`no desktop host helper is published for this platform (${process.platform} ${process.arch})`);
  }
  const asset = helperAssetName(version, target);
  const cacheRoot = options.cacheRoot === undefined ? helperCacheRoot(env) : options.cacheRoot;
  try {
    return await releaseAsset(asset, version, { cacheRoot, fetch: options.fetch, report: options.report });
  } catch (err) {
    if (!(err instanceof ReleaseBinaryError)) throw err;
    throw new DesktopHostUnavailable(downloadFailure(asset, err));
  }
}

function downloadFailure(asset: string, err: ReleaseBinaryError): string {
  if (err.response) {
    return `${asset} could not be downloaded (HTTP ${err.response.status} from ${new URL(err.response.url).host})`;
  }
  if (err.failure === "unreachable") return `${asset} could not be downloaded (${err.message})`;
  return `${asset} could not be used: ${err.message}`;
}

/** `<user cache>/desktop-host`, or `null` with nowhere writable. */
export function helperCacheRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = userCacheRoot(env);
  return root ? writableDir(path.join(root, "desktop-host")) : null;
}

/** The repository this CLI runs from when it is a working copy that holds the helper's crate, else `null`. */
export function detectCheckout(): { root: string } | null {
  if (distributionKind() !== "checkout") return null;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (isFile(manifest)) {
      const root = path.resolve(dir, "..", "..");
      return isFile(path.join(root, "cli", "rust", "desktop-host", "Cargo.toml")) ? { root } : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
