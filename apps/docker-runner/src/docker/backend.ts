import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  SESSION_CONTAINER_LABEL,
  type AdoptedWorkload,
  type BackendWorkload,
  type RunnerBackend,
  type WorkloadCallbacks,
  type WorkloadSpec,
} from "@telorun/runner-core";
import { teloImageRefusal } from "@telorun/runner-core/container";

import { reservedPortsFor, SESSION_ID_LABEL, SUPERVISOR_BUILD_LABEL } from "./container-spec.js";
import { messageOf, type InspectedSessionContainer, type ListedSessionContainer } from "./docker-api.js";
import { runProbe } from "./probe.js";
import {
  createDockerSessionContainerEngine,
  type EngineDockerClient,
} from "./session-container-engine.js";
import {
  containerNameOf,
  describeEnding,
  DockerSessionWorkload,
  removeContainer,
  type DockerWorkloadDeps,
} from "./session-workload.js";
import { SUPERVISOR_ROOT } from "./supervisor-delivery.js";

export interface DockerBackendDeps extends DockerWorkloadDeps {
  docker: DockerWorkloadDeps["docker"] & EngineDockerClient;
  log: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
}

/** Every container a session's workload creates is named with this prefix; a
 *  runner from before the session label is found by it. */
const SESSION_CONTAINER_PREFIX = "telo-run-";

/**
 * Sessions as sibling containers over per-session directories on the bundle
 * volume. A session's directory outlives every container of it (suspend
 * removes the containers, resume mounts the directory again) and goes only with
 * `destroy` or the orphan sweep.
 */
export function createDockerBackend(deps: DockerBackendDeps): RunnerBackend {
  const { docker } = deps;

  /** The session's containers, an ended one included. */
  async function sessionContainers(sessionId: string): Promise<ListedSessionContainer[]> {
    try {
      return await docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`${SESSION_ID_LABEL}=${sessionId}`] }),
      });
    } catch (err) {
      throw new Error(`could not list the session's containers: ${messageOf(err)}`, { cause: err });
    }
  }

  async function removeSessionContainers(sessionId: string): Promise<void> {
    for (const listed of await sessionContainers(sessionId)) {
      await removeContainer(docker.getContainer(listed.Id));
    }
  }

  async function create(spec: WorkloadSpec, callbacks: WorkloadCallbacks): Promise<BackendWorkload> {
    await removeSessionContainers(spec.sessionId);
    return DockerSessionWorkload.create(
      deps,
      { sessionId: spec.sessionId, apps: spec.apps, agent: spec.agent, config: spec.config },
      callbacks,
    );
  }

  /**
   * Take over the containers a previous runner process left. Containers that
   * are gone, never started, or not the stored session's (another app set or
   * agent, or session supervisors of another protocol generation — containers
   * older than this runner build) are removed and the session suspends, its
   * directory kept: its resume creates current ones. A container that has
   * ended is the session's infrastructure failure, named; the sweep then
   * removes what is left.
   */
  async function adopt(spec: WorkloadSpec, callbacks: WorkloadCallbacks): Promise<AdoptedWorkload | undefined> {
    const listed = await sessionContainers(spec.sessionId);
    if (listed.length === 0) return undefined;
    const found: InspectedSessionContainer[] = [];
    for (const c of listed) {
      try {
        found.push(await docker.getContainer(c.Id).inspect());
      } catch (err) {
        throw new Error(`could not inspect container '${c.Id}': ${messageOf(err)}`, { cause: err });
      }
    }
    const ended = found.find((c) => c.State?.Status === "exited" || c.State?.Status === "dead");
    if (ended) throw new Error(`container '${containerNameOf(ended)}' ended (${describeEnding(ended)})`);
    if (found.some((c) => c.State?.Running !== true)) {
      return suspendStale(spec.sessionId, "a container of it is not running");
    }
    const outcome = await DockerSessionWorkload.adopt(
      deps,
      { sessionId: spec.sessionId, apps: spec.apps, agent: spec.agent, config: spec.config },
      callbacks,
      found,
    );
    if (outcome.kind === "adopted") return outcome.adopted;
    return suspendStale(spec.sessionId, outcome.reason);
  }

  async function suspendStale(sessionId: string, reason: string): Promise<undefined> {
    deps.log.info({ sessionId, reason }, "removing session containers this runner cannot adopt, to suspend it");
    await removeSessionContainers(sessionId);
    return undefined;
  }

  /** The session's containers and its directory. */
  async function destroy(sessionId: string): Promise<void> {
    await removeSessionContainers(sessionId);
    await rm(join(deps.bundleRoot, sessionId), { recursive: true, force: true });
  }

  /**
   * Remove what earlier runner processes left: every container of a session
   * that is not live (its workload's and those it started through its engine),
   * every container of a runner from before the session label, every session
   * directory the store does not know, and every supervisor build no container
   * left mounts. Throws naming everything it could not remove.
   */
  async function reapOrphans(sessions: { known: ReadonlySet<string>; live: ReadonlySet<string> }): Promise<void> {
    const failures: string[] = [];
    let containers: ListedSessionContainer[];
    try {
      containers = await docker.listContainers({ all: true });
    } catch (err) {
      throw new Error(`could not list the daemon's containers for the orphan sweep: ${messageOf(err)}`, { cause: err });
    }
    const builds = new Set([deps.supervisor.build]);
    for (const c of containers) {
      const labels = c.Labels ?? {};
      const session = labels[SESSION_ID_LABEL] ?? labels[SESSION_CONTAINER_LABEL];
      const named = (c.Names ?? []).some((n) => n.replace(/^\//, "").startsWith(SESSION_CONTAINER_PREFIX));
      if (session === undefined && !named) continue;
      if (session !== undefined && sessions.live.has(session)) {
        const build = labels[SUPERVISOR_BUILD_LABEL];
        if (build) builds.add(build);
        continue;
      }
      try {
        await removeContainer(docker.getContainer(c.Id));
      } catch (err) {
        failures.push(`container ${c.Names?.[0]?.replace(/^\//, "") ?? c.Id}: ${messageOf(err)}`);
      }
    }
    for (const entry of await entriesOf(deps.bundleRoot)) {
      if (entry.startsWith(".") || sessions.known.has(entry)) continue;
      try {
        await rm(join(deps.bundleRoot, entry), { recursive: true, force: true });
      } catch (err) {
        failures.push(`directory of session ${entry}: ${messageOf(err)}`);
      }
    }
    for (const build of await entriesOf(join(deps.bundleRoot, SUPERVISOR_ROOT))) {
      if (builds.has(build)) continue;
      try {
        await rm(join(deps.bundleRoot, SUPERVISOR_ROOT, build), { recursive: true, force: true });
      } catch (err) {
        failures.push(`supervisor build ${build}: ${messageOf(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`the orphan sweep could not remove ${failures.length} object(s): ${failures.join("; ")}`);
    }
  }

  return {
    probe: (config) =>
      runProbe(docker, { bundleVolume: deps.bundleVolume, childNetwork: deps.childNetwork }, config),
    create,
    adopt,
    destroy,
    // Only what is certain without touching a registry: the pull is create's,
    // where progress and the session ceilings are, and an image that cannot be
    // pulled fails the session on its stream, naming it.
    supplyTelo: async (version) => teloImageRefusal(version, deps.teloImages),
    reservedPorts: reservedPortsFor,
    reapOrphans,
    containers: createDockerSessionContainerEngine({ docker, childNetwork: deps.childNetwork }),
  };
}

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
