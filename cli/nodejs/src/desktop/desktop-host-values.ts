import { SECRET_SEED_HOST_VALUE, STATE_DIR_HOST_VALUE } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { encodeSecretSeed, readOrCreateSecretSeedFile, SecretSeedError } from "@telorun/secret-seed";
import * as path from "node:path";
import { desktopHostDirectory, stateDirectory } from "./desktop-app-directory.js";
import { DesktopHostUnavailable } from "./desktop-host-unavailable.js";

/** The seed file of a desktop application, beside the lock: only the lock holder touches it. */
export const DESKTOP_SEED_FILE = "secret-seed";

function isNamed(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined && env[name] !== "";
}

/**
 * What the desktop host (holding the single-instance lock) gives the kernel
 * unless the environment, env files included, names it: the per-user `state/`
 * as `TELO_HOST_STATE_DIR` and the seed kept in `desktop-host/secret-seed`,
 * created on the first start. A seed file that does not hold a seed refuses,
 * naming the file and never its contents, and is never regenerated.
 */
export function applyDesktopHostValues(appDirectory: string, env: NodeJS.ProcessEnv): void {
  if (!isNamed(env, STATE_DIR_HOST_VALUE)) env[STATE_DIR_HOST_VALUE] = stateDirectory(appDirectory);
  if (isNamed(env, SECRET_SEED_HOST_VALUE)) return;
  const file = path.join(desktopHostDirectory(appDirectory), DESKTOP_SEED_FILE);
  try {
    env[SECRET_SEED_HOST_VALUE] = encodeSecretSeed(readOrCreateSecretSeedFile(file));
  } catch (error) {
    if (error instanceof SecretSeedError) throw new RuntimeError("ERR_NEED_HOST_VALUE_INVALID", error.message);
    throw new DesktopHostUnavailable(`cannot read or create ${file}: ${(error as Error).message}`);
  }
}
