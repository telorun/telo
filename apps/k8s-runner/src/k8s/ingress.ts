import type { V1Ingress, V1OwnerReference, V1Service } from "@kubernetes/client-node";

import type { K8sRunnerConfig } from "../config.js";
import type { PortMapping, RunnerEndpoint } from "@telorun/runner-core";

/** OwnerReference to the session Pod so the Service + Ingress are garbage
 *  collected automatically when the Pod dies — essential for sub-minute
 *  sessions that would otherwise leak ingress objects. */
function podOwnerRef(podName: string, podUid: string): V1OwnerReference {
  return {
    apiVersion: "v1",
    kind: "Pod",
    name: podName,
    uid: podUid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

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
      name: `telo-run-${sessionId}`,
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

export function buildSessionIngress(
  config: K8sRunnerConfig,
  sessionId: string,
  serviceName: string,
  podName: string,
  podUid: string,
  port: number,
): { ingress: V1Ingress; host: string } {
  const host = `${sessionId}.${config.ingressBaseDomain}`;
  const ingress: V1Ingress = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `telo-run-${sessionId}`,
      namespace: config.sessionNamespace,
      labels: { "app.kubernetes.io/managed-by": config.managedByLabel },
      ownerReferences: [podOwnerRef(podName, podUid)],
    },
    spec: {
      ...(config.ingressClassName ? { ingressClassName: config.ingressClassName } : {}),
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: { service: { name: serviceName, port: { number: port } } },
              },
            ],
          },
        },
      ],
    },
  };
  return { ingress, host };
}

/** Endpoints announced on the `running` status. Only the FIRST port is fronted
 *  by the per-session HTTP Ingress (a single service backend, served on 443), so
 *  only it carries an external `url`. Additional ports are not externally routed
 *  — they get host/port for information but no url. Without an ingress base
 *  domain, host is left blank for the client adapter to fill (parity with docker). */
export function endpointsFor(
  config: K8sRunnerConfig,
  sessionId: string,
  ports: PortMapping[],
): RunnerEndpoint[] {
  if (!config.ingressBaseDomain || ports.length === 0) {
    return ports.map((p) => ({ host: "", port: p.port, protocol: p.protocol }));
  }
  const host = `${sessionId}.${config.ingressBaseDomain}`;
  return ports.map((p, i) =>
    i === 0
      ? { host, port: p.port, protocol: p.protocol, url: `https://${host}` }
      : { host: "", port: p.port, protocol: p.protocol },
  );
}
