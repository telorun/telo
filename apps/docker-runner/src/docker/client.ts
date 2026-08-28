import Docker from "dockerode";

export type DockerClient = Docker;

export function createDockerClient(): DockerClient {
  return new Docker({ socketPath: "/var/run/docker.sock" });
}

/** The Engine API version a watch session needs, because it mounts each
 *  session's workspace subdirectory rather than the whole volume. `Subpath`
 *  arrived in v1.45 (Docker 26); an older daemon IGNORES the field and mounts
 *  the volume whole at `/workspace` — one session reading every other session's
 *  files, at a path that looks correct. Silently getting that is worse than not
 *  offering watch sessions at all. */
export const MIN_WATCH_API_VERSION = "1.45";

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

/** Whether this daemon can host watch sessions. An unreachable or unreadable
 *  daemon answers `false`: watch is the capability that needs the guarantee, and
 *  claiming it on no evidence is what the check exists to prevent. */
export async function watchSupportedByDaemon(
  docker: Pick<Docker, "version">,
): Promise<{ supported: boolean; apiVersion?: string }> {
  let apiVersion: string | undefined;
  try {
    apiVersion = (await docker.version()).ApiVersion;
  } catch {
    return { supported: false };
  }
  if (typeof apiVersion !== "string" || apiVersion === "") return { supported: false };
  return { supported: apiVersionAtLeast(apiVersion, MIN_WATCH_API_VERSION), apiVersion };
}
