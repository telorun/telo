import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the runner's image carries the session supervisor. */
export const IMAGE_SUPERVISOR_PATH = "/opt/telo-runner/supervisor";

/** The bundle volume's directory of supervisor builds. Dot-prefixed, so no
 *  session id can name it. */
export const SUPERVISOR_ROOT = ".supervisor";

/** One build of the session supervisor on the bundle volume. */
export interface DeliveredSupervisor {
  /** The binary's content digest (16 hex characters), naming its directory. */
  build: string;
  /** Its directory relative to the volume root: what an app container mounts
   *  at `/opt/telo-runner` through `Subpath`. */
  subpath: string;
}

/**
 * Write the session supervisor onto the bundle volume, where every app
 * container mounts it read-only. Keyed by the binary's digest, so a runner of
 * another build never overwrites what an adopted container still runs, and a
 * restart of the same build writes nothing. Written to a temporary name and
 * renamed, so no container ever mounts half a binary.
 */
export async function deliverSupervisor(binaryPath: string, bundleRoot: string): Promise<DeliveredSupervisor> {
  let bytes: Buffer;
  try {
    bytes = await readFile(binaryPath);
  } catch (err) {
    throw new Error(
      `the session supervisor is not readable at ${binaryPath}: ${(err as Error).message}. ` +
        `It ships in the runner's image; a runner run outside it has no supervisor to deliver.`,
      { cause: err },
    );
  }
  const build = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const subpath = `${SUPERVISOR_ROOT}/${build}`;
  const dir = join(bundleRoot, subpath);
  const target = join(dir, "supervisor");
  if (await exists(target)) return { build, subpath };
  await mkdir(dir, { recursive: true });
  const partial = `${target}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await chmod(partial, 0o755);
  await rename(partial, target);
  return { build, subpath };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
