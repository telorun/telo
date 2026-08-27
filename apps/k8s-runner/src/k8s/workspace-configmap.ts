import { createHash } from "node:crypto";

import { workspaceAppManifest, WORKSPACE_APP_FILENAME } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../config.js";
import type { KubeClient } from "./client.js";

/**
 * The workspace application's manifest, delivered to the pod as a ConfigMap.
 *
 * Named by a hash of its own content, so a runner upgrade that changes the
 * manifest creates a NEW ConfigMap and leaves running sessions mounting the one
 * they booted with — a mutable name would swap a manifest under a live pod, and
 * kubelet ConfigMap propagation is asynchronous, so the failure would be a
 * workspace container that restarts into a different surface at an arbitrary
 * moment.
 *
 * Reconciled by the runner rather than shipped by the chart, so the manifest and
 * the code that depends on it version as one artifact: a chart-only upgrade
 * cannot leave them skewed. The cost is one RBAC rule (`configmaps: get, create`
 * in the session namespace).
 */
const WORKSPACE_CONFIGMAP_PREFIX = "telo-workspace-app-";

export function workspaceConfigMapName(): string {
  const digest = createHash("sha256").update(workspaceAppManifest()).digest("hex").slice(0, 12);
  return `${WORKSPACE_CONFIGMAP_PREFIX}${digest}`;
}

/** Create the ConfigMap if it is not already there. Content-addressed, so an
 *  existing one with this name already holds exactly these bytes and a 409 is
 *  success rather than a conflict to resolve. */
export async function ensureWorkspaceConfigMap(
  kube: KubeClient,
  config: K8sRunnerConfig,
): Promise<string> {
  const name = workspaceConfigMapName();
  try {
    await kube.core.readNamespacedConfigMap({ name, namespace: config.sessionNamespace });
    return name;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await kube.core.createNamespacedConfigMap({
      namespace: config.sessionNamespace,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name,
          namespace: config.sessionNamespace,
          labels: { "app.kubernetes.io/managed-by": config.managedByLabel },
        },
        data: { [WORKSPACE_APP_FILENAME]: workspaceAppManifest() },
      },
    });
  } catch (err) {
    // Two runners (or two concurrent starts) racing to create the same
    // content-addressed name is not a failure — the loser mounts the winner's
    // identical bytes.
    if (!isConflict(err)) throw err;
  }
  return name;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  return e?.statusCode ?? e?.code ?? e?.response?.statusCode;
}

function isNotFound(err: unknown): boolean {
  return statusOf(err) === 404;
}

function isConflict(err: unknown): boolean {
  return statusOf(err) === 409;
}

/**
 * Delete workspace-app ConfigMaps no live pod mounts.
 *
 * The name is content-addressed, so every release that changes the manifest
 * leaves the previous one behind — permanently, since nothing else removes it.
 * Run at boot, alongside the orphan pod reap: a session that survives a runner
 * restart is impossible (the registry is in memory), so anything a live pod
 * still references is a pod this process is about to reap anyway.
 *
 * Keeps the CURRENT hash unconditionally, and skips any map a pod still lists —
 * a mounted ConfigMap that disappears makes the kubelet fail the pod.
 */
export async function sweepWorkspaceConfigMaps(
  kube: KubeClient,
  config: K8sRunnerConfig,
  log: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void },
): Promise<void> {
  const keep = new Set([workspaceConfigMapName()]);
  let pods: Awaited<ReturnType<KubeClient["core"]["listNamespacedPod"]>>;
  let maps: Awaited<ReturnType<KubeClient["core"]["listNamespacedConfigMap"]>>;
  try {
    [pods, maps] = await Promise.all([
      kube.core.listNamespacedPod({ namespace: config.sessionNamespace }),
      kube.core.listNamespacedConfigMap({
        namespace: config.sessionNamespace,
        labelSelector: `app.kubernetes.io/managed-by=${config.managedByLabel}`,
      }),
    ]);
  } catch (err) {
    // Housekeeping, not correctness — a runner that cannot list is a runner
    // whose next boot will try again.
    log.warn({ err }, "could not sweep workspace-app ConfigMaps");
    return;
  }

  for (const pod of pods.items ?? []) {
    for (const volume of pod.spec?.volumes ?? []) {
      if (volume.configMap?.name) keep.add(volume.configMap.name);
    }
  }

  let removed = 0;
  for (const map of maps.items ?? []) {
    const name = map.metadata?.name;
    if (!name?.startsWith(WORKSPACE_CONFIGMAP_PREFIX) || keep.has(name)) continue;
    try {
      await kube.core.deleteNamespacedConfigMap({ name, namespace: config.sessionNamespace });
      removed += 1;
    } catch (err) {
      if (!isNotFound(err)) log.warn({ err, name }, "failed to delete a stale workspace ConfigMap");
    }
  }
  if (removed > 0) log.info({ removed }, "swept stale workspace-app ConfigMaps");
}
