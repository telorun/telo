import { STATE_DIR_HOST_VALUE } from "@telorun/analyzer";
import * as fs from "node:fs";

import { stateDirectory, userAppDirectory } from "./desktop-app-directory.js";
import { DesktopHostUnavailable } from "./desktop-host-unavailable.js";

/**
 * How a packaged desktop app that hosts itself starts, beyond what `telo run`
 * does for any packaged executable: its working directory is the per-user
 * application directory of its `identifier`, which is also where its `.env`
 * files are read (the run's env anchor), and `TELO_HOST_STATE_DIR` is
 * `<that directory>/state`, so the kernel answers every unset
 * `Telo.DurableDirectory` need and child application beneath it.
 *
 * It applies once the host is up — the app IS its own host, which is only known
 * after the env files were read; an app whose host the environment supplies
 * keeps the working directory it was started in and its own state, and only
 * reads its `.env` from the per-user directory. A state directory the
 * environment already names (the real one or an env file's) is the operator's
 * choice and is kept.
 */

export interface PackagedDesktopStartOptions {
  identifier: string;
  /** The environment the directory is derived from, and where the state directory is set. */
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  chdir?: (directory: string) => void;
}

export function enterPackagedDesktopStart(options: PackagedDesktopStartOptions): { appDirectory: string; stateDirectory: string } {
  const appDirectory = userAppDirectory(options.identifier, { env: options.env, platform: options.platform });
  if (!appDirectory) {
    throw new DesktopHostUnavailable("there is no per-user directory for the application (HOME or LOCALAPPDATA is not set)");
  }
  createAppDirectory(appDirectory);
  (options.chdir ?? process.chdir.bind(process))(appDirectory);
  const state = stateDirectory(appDirectory);
  const named = options.env[STATE_DIR_HOST_VALUE];
  if (named === undefined || named === "") options.env[STATE_DIR_HOST_VALUE] = state;
  return { appDirectory, stateDirectory: named ? named : state };
}

/** The application directory exists before anything reads an env file from it, or the walk would start at its parent. */
export function createAppDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
