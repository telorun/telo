import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DesktopHostUnavailable } from "./desktop-host-unavailable.js";

/**
 * What can be refused about this machine before any helper exists: no display
 * on Linux, and macOS older than 14 (the per-application WebKit data store the
 * helper relies on exists from there). Each refusal is
 * `ERR_DESKTOP_HOST_UNAVAILABLE` with the reason as the plan words it.
 */

const MINIMUM_MACOS_MAJOR = 14;

const run = promisify(execFile);

export interface AvailabilityOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The macOS product version (`13.6`); asked of `sw_vers` by default. */
  macosVersion?: () => Promise<string>;
}

export async function assertDesktopAvailable(options: AvailabilityOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "linux" && !env.WAYLAND_DISPLAY && !env.DISPLAY) {
    throw new DesktopHostUnavailable("no display (neither WAYLAND_DISPLAY nor DISPLAY is set)");
  }
  if (platform === "darwin") {
    const version = await (options.macosVersion ?? swVersProductVersion)();
    const major = Number.parseInt(version, 10);
    if (!Number.isFinite(major)) {
      throw new DesktopHostUnavailable(`the macOS version could not be read (sw_vers answered '${version}')`);
    }
    if (major < MINIMUM_MACOS_MAJOR) {
      throw new DesktopHostUnavailable(
        `macOS ${MINIMUM_MACOS_MAJOR} or later is required (this is macOS ${version})`,
      );
    }
  }
}

async function swVersProductVersion(): Promise<string> {
  try {
    return (await run("sw_vers", ["-productVersion"])).stdout.trim();
  } catch (err) {
    throw new DesktopHostUnavailable(`the macOS version could not be read (${(err as Error).message})`);
  }
}
