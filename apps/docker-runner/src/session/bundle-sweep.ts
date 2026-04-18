import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyBaseLogger } from "fastify";

export interface SweepDockerClient {
  getContainer(name: string): { inspect(): Promise<unknown> };
}

/**
 * On startup, purge /bundles/<id> directories that have no matching live
 * container on the daemon. Covers ungraceful restarts where the runner died
 * mid-session and containers were --rm'd by the daemon but bundle dirs remain.
 *
 * A missing daemon at startup is a no-op — the daemon-reachable path will run
 * next time. A dir with a still-live container is kept (the runner has
 * restarted while the container ran on; on next terminal the container is
 * --rm'd and the next sweep will reclaim).
 */
export async function sweepOrphanBundles(
  bundleRoot: string,
  docker: SweepDockerClient,
  log: Pick<FastifyBaseLogger, "info" | "warn">,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(bundleRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // volume mount empty on first boot
    log.warn({ err }, "failed to scan bundle root for sweep");
    return;
  }

  let removed = 0;
  for (const name of entries) {
    const full = join(bundleRoot, name);
    try {
      const s = await stat(full);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const containerName = `telo-run-${name}`;
    let hasLiveContainer = false;
    try {
      await docker.getContainer(containerName).inspect();
      hasLiveContainer = true;
    } catch {
      // 404 on inspect = no such container on daemon.
    }

    if (hasLiveContainer) continue;

    try {
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn({ err, dir: full }, "failed to remove orphan bundle dir");
    }
  }

  if (removed > 0) {
    log.info({ removed }, "swept orphan bundle directories");
  }
}
