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

/** Host fronting a single tcp port: `<port>-<sessionId>.<domain>`. The port
 *  rides as a leading label (no dots), so it stays a single label under the base
 *  domain — matching the docker runner's proxy scheme and compatible with a
 *  single-label wildcard cert (`*.<domain>`). */
function hostForPort(config: K8sRunnerConfig, sessionId: string, port: number): string {
  return `${port}-${sessionId}.${config.ingressBaseDomain}`;
}

export function buildSessionIngress(
  config: K8sRunnerConfig,
  sessionId: string,
  serviceName: string,
  podName: string,
  podUid: string,
  ports: PortMapping[],
): { ingress: V1Ingress; hosts: string[] } {
  // Only tcp ports are HTTP-routable; one host rule per port to the matching
  // service port, mirroring the docker runner's per-port URLs.
  const rules = ports
    .filter((p) => p.protocol === "tcp")
    .map((p) => ({
      host: hostForPort(config, sessionId, p.port),
      http: {
        paths: [
          {
            path: "/",
            pathType: "Prefix" as const,
            backend: { service: { name: serviceName, port: { number: p.port } } },
          },
        ],
      },
    }));
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
      rules,
    },
  };
  return { ingress, hosts: rules.map((r) => r.host) };
}

/** Endpoints announced on the `running` status. Every tcp port is fronted by its
 *  own per-session Ingress host (`<port>-<sessionId>.<domain>`, served on 443) and
 *  carries an external `url`. udp ports aren't HTTP-routable, so they keep the
 *  host-less form. Without an ingress base domain, host is left blank for the
 *  client adapter to fill (parity with docker). */
export function endpointsFor(
  config: K8sRunnerConfig,
  sessionId: string,
  ports: PortMapping[],
): RunnerEndpoint[] {
  if (!config.ingressBaseDomain || ports.length === 0) {
    return ports.map((p) => ({ host: "", port: p.port, protocol: p.protocol }));
  }
  return ports.map((p) => {
    if (p.protocol !== "tcp") {
      return { host: "", port: p.port, protocol: p.protocol };
    }
    const host = hostForPort(config, sessionId, p.port);
    return { host, port: p.port, protocol: p.protocol, url: `https://${host}` };
  });
}
