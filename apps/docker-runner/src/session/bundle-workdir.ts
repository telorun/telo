import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { posix, sep } from "node:path";

import type { RunBundle } from "../types.js";

export class BundleWorkdirError extends Error {}

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
    // and read regardless of the runner's UID (see UID-alignment section in the
    // plan). Files default to 0644 which is already world-readable.
    await chmod(sessionDir, 0o755);

    return new BundleWorkdir(bundleRoot, sessionDir, sessionId);
  }

  async cleanup(): Promise<void> {
    await rm(this.sessionDir, { recursive: true, force: true });
  }
}

function validateSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new BundleWorkdirError(`invalid sessionId '${id}' (must match /^[a-zA-Z0-9_-]+$/)`);
  }
}

// Paths from the bundle arrive POSIX-style and untrusted — guard against
// traversal explicitly rather than trusting path.resolve.
export function normalizeBundlePath(p: string): string {
  const normalized = posix.normalize(p).replace(/^\/+/, "");
  if (normalized === "" || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new BundleWorkdirError(`invalid bundle relativePath '${p}'`);
  }
  for (const part of normalized.split("/")) {
    if (part === "..") throw new BundleWorkdirError(`invalid bundle relativePath '${p}'`);
  }
  return normalized;
}

function joinHostPath(...parts: string[]): string {
  return parts.join(sep).replace(/\/+/g, sep);
}

function dirnameHost(p: string): string {
  const idx = p.lastIndexOf(sep);
  return idx <= 0 ? sep : p.slice(0, idx);
}
