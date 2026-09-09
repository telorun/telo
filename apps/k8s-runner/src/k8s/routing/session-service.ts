import type { V1OwnerReference, V1Service } from "@kubernetes/client-node";

import type { PortMapping } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../../config.js";

/** OwnerReference to the session Pod so every routing object is garbage collected
 *  when the Pod dies — essential for sub-minute sessions that would otherwise leak
 *  routing objects. Both routing layers use it: an HTTPRoute is namespaced like an
 *  Ingress, so the same ownership works unchanged. */
export function podOwnerRef(podName: string, podUid: string): V1OwnerReference {
  return {
    apiVersion: "v1",
    kind: "Pod",
    name: podName,
    uid: podUid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

/** The name every routing object for one session shares. */
export function sessionObjectName(sessionId: string): string {
  return `telo-run-${sessionId}`;
}

/** The Service both routing layers point at — the routing layer decides how
 *  traffic ARRIVES, never what it arrives at, so this is layer-neutral. */
export function buildSessionService(
  config: K8sRunnerConfig,
  sessionId: string,
  podName: string,
  podUid: string,
  ports: PortMapping[],
): V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: sessionObjectName(sessionId),
      namespace: config.sessionNamespace,
      labels: { "app.kubernetes.io/managed-by": config.managedByLabel },
      ownerReferences: [podOwnerRef(podName, podUid)],
    },
    spec: {
      selector: { "telo.run/session-id": sessionId },
      ports: ports.map((p) => ({
        name: `p${p.port}`,
        port: p.port,
        targetPort: p.port,
        protocol: p.protocol.toUpperCase(),
      })),
    },
  };
}
