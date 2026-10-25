import type { V1Pod } from "@kubernetes/client-node";
import {
  isUnreleasedTelo,
  SESSION_CONTAINER_LABEL,
  type AdoptedWorkload,
  type AvailabilityReport,
  type BackendWorkload,
  type RunnerBackend,
  type WorkloadCallbacks,
  type WorkloadSpec,
} from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../config.js";
import { apiReason, withCause } from "./api-error.js";
import type { KubeClient } from "./client.js";
import { APP_SLOTS, MANAGED_BY_LABEL, reservedPortsFor, SESSION_ID_LABEL } from "./pod-spec.js";
import { deletePod, endedContainer, keepPod, msg, podHasFailed, podPhase, removeOrKeepPod } from "./pod-status.js";
import type { SessionRouter } from "./routing/index.js";
import { createKubernetesSessionContainerEngine } from "./session-container-engine.js";
import { deleteSessionVolume } from "./session-volume.js";
import { KubernetesSessionWorkload, type SessionWorkloadDeps } from "./session-workload.js";
import { sweepWorkspaceConfigMaps } from "./workspace-configmap.js";

export { podFailureMessage } from "./pod-status.js";

export interface K8sBackendDeps {
  kube: KubeClient;
  config: K8sRunnerConfig;
  /** How this cluster publishes session routes, resolved once at boot. Absent →
   *  logs-only: no base domain, or `SESSION_ROUTING_MODE=none`. */
  router?: SessionRouter;
  log: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
}

/**
 * Sessions as pods over per-session PersistentVolumeClaims. The claim outlives
 * every pod of its session (suspend deletes the pod, resume mounts the claim
 * again) and goes only with `destroy` or the orphan sweep.
 */
export function createKubernetesBackend(deps: K8sBackendDeps): RunnerBackend {
  const { kube, config, router } = deps;
  const ns = config.sessionNamespace;
  const workloadDeps: SessionWorkloadDeps = { kube, config, router };

  async function probe(): Promise<AvailabilityReport> {
    try {
      await kube.core.readNamespace({ name: ns });
    } catch {
      const reachable = await clusterReachable(kube);
      if (!reachable) {
        return {
          status: "unavailable",
          message: "Kubernetes API server not reachable from the runner.",
          remediation: "Check the runner's in-cluster ServiceAccount and RBAC.",
        };
      }
      return {
        status: "unavailable",
        message: `Session namespace '${ns}' does not exist.`,
        remediation: `Install the runner's Helm chart, which provisions the '${ns}' namespace.`,
      };
    }
    return { status: "ready" };
  }

  /** The session's pods, a terminating one included. */
  async function sessionPods(sessionId: string): Promise<V1Pod[]> {
    try {
      const list = await kube.core.listNamespacedPod({
        namespace: ns,
        labelSelector: `${MANAGED_BY_LABEL}=${config.managedByLabel},${SESSION_ID_LABEL}=${sessionId}`,
      });
      return list.items ?? [];
    } catch (err) {
      throw withCause(new Error(`could not list the session's pods: ${apiReason(err)}`), err);
    }
  }

  /** Remove every pod of a session and wait for them to go: one a failed
   *  adoption left, or one still terminating, must not share the volume with
   *  the next. */
  async function removeSessionPods(sessionId: string): Promise<void> {
    for (const pod of await sessionPods(sessionId)) {
      await removeOrKeepPod(kube, ns, pod, config.keepFailedPods);
    }
  }

  async function create(spec: WorkloadSpec, callbacks: WorkloadCallbacks): Promise<BackendWorkload> {
    await removeSessionPods(spec.sessionId);
    return KubernetesSessionWorkload.create(
      workloadDeps,
      { sessionId: spec.sessionId, apps: spec.apps, agent: spec.agent, config: spec.config },
      callbacks,
    );
  }

  /**
   * Take over the pod a previous runner process left. A pod that is gone, not
   * Running, or not the stored session's (another app set or agent, or session
   * supervisors of another protocol generation — a pod older than this runner
   * build) is removed and the session suspends, its storage kept: its resume
   * builds a current pod. A container that has ended is the session's
   * infrastructure failure, named; the sweep then removes the pod.
   */
  async function adopt(spec: WorkloadSpec, callbacks: WorkloadCallbacks): Promise<AdoptedWorkload | undefined> {
    const pods = (await sessionPods(spec.sessionId)).filter((p) => !p.metadata?.deletionTimestamp);
    if (pods.length === 0) return undefined;
    const pod = pods.length === 1 && podPhase(pods[0]) === "Running" ? pods[0]! : undefined;
    if (!pod) {
      deps.log.info({ sessionId: spec.sessionId }, "removing a session pod that is not running, to suspend it");
      await removeSessionPods(spec.sessionId);
      return undefined;
    }
    const ended = endedContainer(pod);
    if (ended) throw new Error(ended);
    const outcome = await KubernetesSessionWorkload.adopt(
      workloadDeps,
      { sessionId: spec.sessionId, apps: spec.apps, agent: spec.agent, config: spec.config },
      callbacks,
      pod,
    );
    if (outcome.kind === "adopted") return outcome.adopted;
    deps.log.info(
      { sessionId: spec.sessionId, reason: outcome.reason },
      "removing a session pod this runner cannot adopt, to suspend it",
    );
    await removeSessionPods(spec.sessionId);
    return undefined;
  }

  /** The session's pod and its volume. The Service, the routing objects and the
   *  session-container NetworkPolicies are owned by the pod, so the cluster
   *  collects them with it. */
  async function destroy(sessionId: string): Promise<void> {
    await removeSessionPods(sessionId);
    await deleteSessionVolume(kube, config, sessionId);
  }

  /**
   * Remove what earlier runner processes left: every managed pod of a session
   * that is not live (its Service, routes and policies are collected with it),
   * every session container's pod of one, and every session volume of a session
   * the store does not know. Then the workspace-app ConfigMaps no pod mounts.
   */
  async function reapOrphans(sessions: { known: ReadonlySet<string>; live: ReadonlySet<string> }): Promise<void> {
    const managed = `${MANAGED_BY_LABEL}=${config.managedByLabel}`;
    const failures: string[] = [];
    let pods: V1Pod[];
    let claims: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }>;
    try {
      [pods, claims] = await Promise.all([
        kube.core.listNamespacedPod({ namespace: ns, labelSelector: managed }).then((l) => l.items ?? []),
        kube.core
          .listNamespacedPersistentVolumeClaim({ namespace: ns, labelSelector: managed })
          .then((l) => l.items ?? []),
      ]);
    } catch (err) {
      throw withCause(new Error(`could not list the session namespace for the orphan sweep: ${apiReason(err)}`), err);
    }
    for (const pod of pods) {
      const name = pod.metadata?.name;
      const labels = pod.metadata?.labels ?? {};
      const session = labels[SESSION_ID_LABEL] ?? labels[SESSION_CONTAINER_LABEL];
      if (!name || (session !== undefined && sessions.live.has(session))) continue;
      try {
        if (config.keepFailedPods && podHasFailed(pod)) await keepPod(kube, ns, name);
        else await deletePod(kube, ns, name);
      } catch (err) {
        failures.push(`pod ${name}: ${apiReason(err)}`);
      }
    }
    for (const claim of claims) {
      const session = claim.metadata?.labels?.[SESSION_ID_LABEL];
      if (session === undefined || sessions.known.has(session)) continue;
      try {
        await deleteSessionVolume(kube, config, session);
      } catch (err) {
        failures.push(`volume of session ${session}: ${msg(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`the orphan sweep could not remove ${failures.length} object(s): ${failures.join("; ")}`);
    }
    await sweepWorkspaceConfigMaps(kube, config, deps.log);
  }

  // A telo version is a release binary the apps container downloads, so a build
  // identity that was never released has nothing to fetch.
  async function supplyTelo(version: string): Promise<string | undefined> {
    if (!isUnreleasedTelo(version)) return undefined;
    return (
      `${version} is an unreleased build, which has no published binary. ` +
      `Pin a released telo version for this workspace.`
    );
  }

  return {
    probe,
    create,
    adopt,
    destroy,
    supplyTelo,
    reservedPorts: reservedPortsFor,
    maxApps: APP_SLOTS,
    reapOrphans,
    containers: createKubernetesSessionContainerEngine({ kube, config }),
  };
}

async function clusterReachable(kube: KubeClient): Promise<boolean> {
  try {
    await kube.core.listNamespace();
    return true;
  } catch {
    return false;
  }
}
