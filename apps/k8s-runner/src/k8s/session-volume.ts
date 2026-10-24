import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";

import type { K8sRunnerConfig } from "../config.js";
import { apiFailure, apiReason, withCause } from "./api-error.js";
import type { KubeClient } from "./client.js";
import { MANAGED_BY_LABEL, SESSION_ID_LABEL } from "./pod-spec.js";
import { is404, isConflict } from "./pod-status.js";

/**
 * A session's own storage: one PersistentVolumeClaim holding `workspace/`
 * (mounted at `/workspace`, its `.telo` module cache included) and `agent/`
 * (the co-resident agent's state). Owned by nothing a pod's deletion collects,
 * so suspending a session — deleting its pod — keeps it, and the next pod
 * mounts the same claim. Only `destroy` and the orphan sweep delete it.
 */
export function sessionVolumeName(sessionId: string): string {
  return `telo-session-${sessionId}`;
}

export function buildSessionVolume(config: K8sRunnerConfig, sessionId: string): V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: sessionVolumeName(sessionId),
      namespace: config.sessionNamespace,
      labels: {
        [MANAGED_BY_LABEL]: config.managedByLabel,
        [SESSION_ID_LABEL]: sessionId,
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: config.sessionStorage.size } },
      ...(config.sessionStorage.storageClassName
        ? { storageClassName: config.sessionStorage.storageClassName }
        : {}),
    },
  };
}

/** Create the session's claim unless it is already there; returns its name. */
export async function ensureSessionVolume(
  kube: KubeClient,
  config: K8sRunnerConfig,
  sessionId: string,
): Promise<string> {
  const body = buildSessionVolume(config, sessionId);
  try {
    await kube.core.createNamespacedPersistentVolumeClaim({ namespace: config.sessionNamespace, body });
  } catch (err) {
    if (!isConflict(err)) throw apiFailure(err, "create", "could not create the session's storage");
  }
  return body.metadata!.name!;
}

export async function deleteSessionVolume(
  kube: KubeClient,
  config: K8sRunnerConfig,
  sessionId: string,
): Promise<void> {
  try {
    await kube.core.deleteNamespacedPersistentVolumeClaim({
      name: sessionVolumeName(sessionId),
      namespace: config.sessionNamespace,
    });
  } catch (err) {
    if (!is404(err)) {
      throw withCause(new Error(`could not delete the session's storage: ${apiReason(err)}`), err);
    }
  }
}
