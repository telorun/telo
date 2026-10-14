import type { FastifyBaseLogger } from "fastify";
import { SESSION_CONTAINER_LABEL } from "@telorun/runner-core";

/** A container as the daemon lists it. Only the fields the reaper reads. */
export interface ListedContainer {
  Names?: string[];
  Id?: string;
  Labels?: Record<string, string>;
}

export interface ReapDockerClient {
  listContainers(opts: { all: boolean }): Promise<ListedContainer[]>;
  getContainer(name: string): { remove(opts?: { force?: boolean; v?: boolean }): Promise<unknown> };
}

/** Every container a session owns is named `telo-run-<sessionId>[-<role>]`. */
const SESSION_CONTAINER_PREFIX = "telo-run-";

/**
 * Remove containers left behind by a previous runner process.
 *
 * A RUN session's container exits on its own and the daemon `--rm`s it, which is
 * why this did not exist before. A WATCH session's containers do not: the whole
 * point is that they outlive their runs, so a runner restart leaves a workspace
 * container, an agent and one container per app running with nothing driving
 * them — the session registry is in memory, so nothing can even reach them to
 * stop them.
 *
 * Matched by the session name prefix, which every session container carries,
 * and by the session label a container a session started through its engine
 * carries — it has no name of the runner's, and its session is as gone as the
 * rest. `all: true` picks up exited ones too, so a stopped-but-not-removed
 * container cannot block a later session reusing its name.
 */
export async function reapOrphanContainers(
  docker: ReapDockerClient,
  log: Pick<FastifyBaseLogger, "info" | "warn">,
): Promise<void> {
  let containers: ListedContainer[];
  try {
    containers = await docker.listContainers({ all: true });
  } catch (err) {
    // An unreachable daemon at boot is not this function's failure to report —
    // the boot-state check already covers it, and the next start will reap.
    log.warn({ err }, "could not list containers to reap session orphans");
    return;
  }

  let removed = 0;
  for (const container of containers) {
    const name =
      (container.Names ?? [])
        .map((n) => (n.startsWith("/") ? n.slice(1) : n))
        .find((n) => n.startsWith(SESSION_CONTAINER_PREFIX)) ??
      (container.Labels?.[SESSION_CONTAINER_LABEL] !== undefined ? container.Id : undefined);
    if (!name) continue;
    try {
      await docker.getContainer(name).remove({ force: true, v: true });
      removed += 1;
    } catch (err) {
      log.warn({ err, container: name }, "failed to remove orphan session container");
    }
  }

  if (removed > 0) log.info({ removed }, "reaped orphan session containers");
}
