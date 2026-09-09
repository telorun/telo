import type { V1Ingress } from "@kubernetes/client-node";

import type { PortMapping } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../../config.js";
import type { KubeClient } from "../client.js";
import { is404 } from "../pod-status.js";
import { createOrReplace } from "./create-or-replace.js";
import { hostForPort } from "./session-endpoints.js";
import { podOwnerRef, sessionObjectName } from "./session-service.js";
import type {
  PublishedRoute,
  PublishRouteArgs,
  RouteVerdict,
  SessionRouter,
} from "./session-router.js";

/** One Ingress carries every host for a session: unlike Gateway API, an Ingress
 *  rule is scoped to its own host, so per-host backends fit in one object. */
export function buildSessionIngress(
  config: K8sRunnerConfig,
  sessionId: string,
  serviceName: string,
  podName: string,
  podUid: string,
  ports: PortMapping[],
): { ingress: V1Ingress; hosts: string[] } {
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
      name: sessionObjectName(sessionId),
      namespace: config.sessionNamespace,
      labels: {
        "app.kubernetes.io/managed-by": config.managedByLabel,
        "telo.run/session-id": sessionId,
      },
      ownerReferences: [podOwnerRef(podName, podUid)],
    },
    spec: {
      ...(config.sessionRouting.ingressClassName
        ? { ingressClassName: config.sessionRouting.ingressClassName }
        : {}),
      // Present the predefined cert (e.g. a Cloudflare Origin cert) so an upstream
      // in Full (Strict) mode can validate the origin. Only meaningful with routable
      // hosts; a single wildcard `*.<domain>` Secret covers every session host.
      ...(config.sessionRouting.tlsSecretName && rules.length > 0
        ? {
            tls: [
              {
                hosts: rules.map((r) => r.host),
                secretName: config.sessionRouting.tlsSecretName,
              },
            ],
          }
        : {}),
      rules,
    },
  };
  return { ingress, hosts: rules.map((r) => r.host) };
}

export function createIngressRouter(kube: KubeClient, config: K8sRunnerConfig): SessionRouter {
  const ns = config.sessionNamespace;

  return {
    layer: "ingress",

    async publish(args: PublishRouteArgs): Promise<PublishedRoute[]> {
      const { ingress } = buildSessionIngress(
        config,
        args.sessionId,
        args.serviceName,
        args.podName,
        args.podUid,
        args.ports,
      );
      const name = ingress.metadata!.name!;
      const rules = ingress.spec?.rules ?? [];
      // No tcp ports → nothing HTTP-routable. DELETE rather than return: a reload
      // that drops the last routed port would otherwise leave the previous
      // Ingress serving a port nothing listens on. (The Service stays for any udp.)
      if (rules.length === 0) {
        try {
          await kube.networking.deleteNamespacedIngress({ name, namespace: ns });
        } catch (err) {
          if (!is404(err)) throw err;
        }
        return [];
      }
      await createOrReplace(
        () => kube.networking.createNamespacedIngress({ namespace: ns, body: ingress }),
        async () => {
          const existing = await kube.networking.readNamespacedIngress({ name, namespace: ns });
          await kube.networking.replaceNamespacedIngress({
            name,
            namespace: ns,
            body: {
              ...ingress,
              metadata: {
                ...ingress.metadata,
                resourceVersion: existing.metadata?.resourceVersion,
              },
            },
          });
        },
      );
      return args.ports
        .filter((p) => p.protocol === "tcp")
        .map((p) => ({ host: hostForPort(config, args.sessionId, p.port), port: p.port }));
    },

    /**
     * Ingress offers no rejection signal — a controller that refuses a rule simply
     * never writes status — so this only ever answers `programmed` or `pending`,
     * and an unclaimed Ingress is caught by the deadline rather than by a reason
     * the cluster gave. That is the weaker half of the two layers, and it is a
     * property of the API, not of this implementation.
     */
    async verdictFor(sessionId: string): Promise<RouteVerdict> {
      try {
        const ingress = await kube.networking.readNamespacedIngress({
          name: sessionObjectName(sessionId),
          namespace: ns,
        });
        const assigned = ingress.status?.loadBalancer?.ingress ?? [];
        return assigned.length > 0 ? { kind: "programmed" } : { kind: "pending" };
      } catch (err) {
        if (is404(err)) return { kind: "pending" };
        throw err;
      }
    },

    unclaimedReason(): string {
      const cls = config.sessionRouting.ingressClassName;
      return (
        `no ingress controller claimed the session Ingress` +
        (cls ? ` for class '${cls}'` : " (no ingressClassName configured)") +
        `. Check that an Ingress controller is installed and watching namespace '${ns}'.`
      );
    },
  };
}
