import Docker from "dockerode";
import { RunnerConfigError } from "@telorun/runner-core";

export type DockerClient = Docker;

export function createDockerClient(): DockerClient {
  return new Docker({ socketPath: "/var/run/docker.sock" });
}

/** The Engine API version every session needs: its app and agent containers
 *  mount the session's own directories of the bundle volume, and the session
 *  supervisor's, through `Subpath`. It arrived in v1.45 (Docker 26); an older
 *  daemon IGNORES the field and mounts the volume whole — one session reading
 *  every other session's files, at a path that looks correct. */
export const MIN_SUBPATH_API_VERSION = "1.45";

/** Compares dotted numeric API versions (`1.45` ≥ `1.9` — which a string
 *  comparison gets wrong). */
export function apiVersionAtLeast(actual: string, minimum: string): boolean {
  const parse = (v: string): number[] => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [a, b] = [parse(actual), parse(minimum)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * Refuse to boot on a daemon that cannot scope a mount to a subdirectory, or
 * that cannot be asked: with one session shape there is nothing to degrade
 * into, and starting anyway would mount every session's files into every
 * container.
 */
export async function refuseDaemonWithoutSubpath(docker: {
  version(): Promise<{ ApiVersion?: string }>;
}): Promise<void> {
  let apiVersion: unknown;
  try {
    apiVersion = (await docker.version()).ApiVersion;
  } catch (err) {
    throw new RunnerConfigError(
      `The docker daemon at /var/run/docker.sock could not be asked for its version (${(err as Error).message}). ` +
        `This runner needs Docker Engine API ${MIN_SUBPATH_API_VERSION} or newer (Docker 26+); ` +
        `make the daemon reachable and start the runner again.`,
    );
  }
  if (typeof apiVersion === "string" && apiVersion !== "" && apiVersionAtLeast(apiVersion, MIN_SUBPATH_API_VERSION)) {
    return;
  }
  throw new RunnerConfigError(
    `This runner needs Docker Engine API ${MIN_SUBPATH_API_VERSION} or newer (Docker 26+), and this daemon reports ` +
      `${typeof apiVersion === "string" && apiVersion !== "" ? `API ${apiVersion}` : "no readable API version"}. ` +
      `A session's containers mount its own directories of the bundle volume through \`Subpath\`, which an older ` +
      `daemon ignores, mounting every session's files instead. Upgrade Docker to 26 or newer.`,
  );
}
