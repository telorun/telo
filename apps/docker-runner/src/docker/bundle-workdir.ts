import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { sep } from "node:path";

import { normalizeBundlePath, validateSessionId, type RunBundle } from "@telorun/runner-core";

/**
 * Docker-specific bundle delivery: writes the bundle files into a per-session
 * directory on the shared named volume the spawned container mounts at /srv.
 * (The k8s backend delivers bundles differently — initContainer fetch — so this
 * lives in the docker backend, not runner-core.)
 */
export class BundleWorkdir {
  private constructor(
    public readonly root: string,
    public readonly sessionDir: string,
    public readonly sessionId: string,
  ) {}

  static async create(
    bundleRoot: string,
    sessionId: string,
    bundle: RunBundle,
  ): Promise<BundleWorkdir> {
    validateSessionId(sessionId);
    const sessionDir = joinHostPath(bundleRoot, sessionId);
    await mkdir(sessionDir, { recursive: true });

    for (const file of bundle.files) {
      const rel = normalizeBundlePath(file.relativePath);
      const absPath = joinHostPath(sessionDir, ...rel.split("/"));
      await mkdir(dirnameHost(absPath), { recursive: true });
      await writeFile(absPath, file.contents, { encoding: "utf8" });
    }

    // chmod 0755 on the session dir so non-root spawned containers can traverse
    // and read regardless of the runner's UID. Files default to 0644.
    await chmod(sessionDir, 0o755);

    return new BundleWorkdir(bundleRoot, sessionDir, sessionId);
  }

  async cleanup(): Promise<void> {
    await rm(this.sessionDir, { recursive: true, force: true });
  }
}

function joinHostPath(...parts: string[]): string {
  return parts.join(sep).replace(/\/+/g, sep);
}

function dirnameHost(p: string): string {
  const idx = p.lastIndexOf(sep);
  return idx <= 0 ? sep : p.slice(0, idx);
}
