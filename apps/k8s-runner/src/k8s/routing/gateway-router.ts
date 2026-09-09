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

const GROUP = "gateway.networking.k8s.io";
const PLURAL = "httproutes";

/**
 * ONE HTTPRoute PER PORT, and that is forced by the API rather than chosen:
 * `hostnames` is a property of the whole HTTPRoute, while a `rule` selects on
 * path/header/method — never on host. A single route carrying every session
 * hostname plus one rule per port would therefore send every host to whichever
 * rule matched `/` first, silently collapsing all of a session's ports onto one.
 *
 * An Ingress rule owns its host, which is why that layer needs only one object.
 */
function routeName(sessionId: string, port: number): string {
  return `${sessionObjectName(sessionId)}-${port}`;
}

interface RouteCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

interface RouteParentStatus {
  conditions?: RouteCondition[];
}

interface HttpRouteObject {
  metadata?: { name?: string; resourceVersion?: string };
  status?: { parents?: RouteParentStatus[] };
}

function condition(parent: RouteParentStatus, type: string): RouteCondition | undefined {
  return parent.conditions?.find((c) => c.type === type);
}

/** Phrase a refusal in the controller's own words — every cause here is fixed in
 *  the cluster (a listener that does not admit this namespace, a hostname outside
 *  the listener's own), so the controller's `reason` is the actionable part. */
function refusal(c: RouteCondition): string {
  const reason = c.reason ?? "rejected";
  return c.message ? `${reason}: ${c.message}` : reason;
}

export function createGatewayRouter(
  kube: KubeClient,
  config: K8sRunnerConfig,
  apiVersion: string,
): SessionRouter {
  const ns = config.sessionNamespace;
  const gateway = config.sessionRouting.gateway;
  if (!gateway) {
    // Unreachable through the factory, which refuses this at boot; kept so the
    // invariant is stated where the field is read rather than assumed.
    throw new Error("gateway routing selected without a configured Gateway parent");
  }
  const base = { group: GROUP, version: apiVersion, namespace: ns, plural: PLURAL };

  // Arrow consts, not declarations: a hoisted `function` resets the narrowing of
  // `gateway` above, since TypeScript cannot prove it is not called earlier.
  const buildRoute = (args: PublishRouteArgs, port: number): Record<string, unknown> => {
    return {
      apiVersion: `${GROUP}/${apiVersion}`,
      kind: "HTTPRoute",
      metadata: {
        name: routeName(args.sessionId, port),
        namespace: ns,
        labels: {
          "app.kubernetes.io/managed-by": config.managedByLabel,
          "telo.run/session-id": args.sessionId,
        },
        ownerReferences: [podOwnerRef(args.podName, args.podUid)],
      },
      spec: {
        parentRefs: [
          {
            group: GROUP,
            kind: "Gateway",
            name: gateway.name,
            namespace: gateway.namespace,
            ...(gateway.sectionName ? { sectionName: gateway.sectionName } : {}),
          },
        ],
        hostnames: [hostForPort(config, args.sessionId, port)],
        rules: [
          {
            matches: [{ path: { type: "PathPrefix", value: "/" } }],
            backendRefs: [{ name: args.serviceName, port }],
          },
        ],
      },
    };
  };

  const listSessionRoutes = async (sessionId: string): Promise<HttpRouteObject[]> => {
    const list = (await kube.custom.listNamespacedCustomObject({
      ...base,
      labelSelector: `telo.run/session-id=${sessionId}`,
    })) as { items?: HttpRouteObject[] };
    return list.items ?? [];
  };

  return {
    layer: "gateway",

    async publish(args: PublishRouteArgs): Promise<PublishedRoute[]> {
      const tcp = args.ports.filter((p) => p.protocol === "tcp");
      const desired = new Set(tcp.map((p) => routeName(args.sessionId, p.port)));

      for (const p of tcp) {
        const body = buildRoute(args, p.port);
        const name = routeName(args.sessionId, p.port);
        await createOrReplace(
          () => kube.custom.createNamespacedCustomObject({ ...base, body }),
          async () => {
            const existing = (await kube.custom.getNamespacedCustomObject({
              ...base,
              name,
            })) as HttpRouteObject;
            await kube.custom.replaceNamespacedCustomObject({
              ...base,
              name,
              body: {
                ...body,
                metadata: {
                  ...(body.metadata as Record<string, unknown>),
                  resourceVersion: existing.metadata?.resourceVersion,
                },
              },
            });
          },
        );
      }

      // A reload that DROPS a port must delete that port's route. In ingress mode
      // the single object is replaced and the stale rule vanishes with it; here
      // each port owns an object, so a removed one would keep routing to a port
      // nothing listens on.
      for (const existing of await listSessionRoutes(args.sessionId)) {
        const name = existing.metadata?.name;
        if (!name || desired.has(name)) continue;
        try {
          await kube.custom.deleteNamespacedCustomObject({ ...base, name });
        } catch (err) {
          if (!is404(err)) throw err;
        }
      }

      return tcp.map((p) => ({
        host: hostForPort(config, args.sessionId, p.port),
        port: p.port,
      }));
    },

    /**
     * Gateway API is the layer that can actually answer this: a controller writes
     * `Accepted` and `ResolvedRefs` per parent, so a route refused because the
     * Gateway's listener does not admit this namespace says exactly that
     * (`NotAllowedByListeners`) instead of timing out with no cause.
     */
    async verdictFor(sessionId: string, route: PublishedRoute): Promise<RouteVerdict> {
      let obj: HttpRouteObject;
      try {
        obj = (await kube.custom.getNamespacedCustomObject({
          ...base,
          name: routeName(sessionId, route.port),
        })) as HttpRouteObject;
      } catch (err) {
        if (is404(err)) return { kind: "pending" };
        throw err;
      }
      const parents = obj.status?.parents ?? [];
      if (parents.length === 0) return { kind: "pending" };

      let rejected: string | undefined;
      for (const parent of parents) {
        const accepted = condition(parent, "Accepted");
        const resolved = condition(parent, "ResolvedRefs");
        if (accepted?.status === "False") {
          rejected ??= refusal(accepted);
          continue;
        }
        if (resolved?.status === "False") {
          rejected ??= refusal(resolved);
          continue;
        }
        // A route may attach to several parents; one that programmed it is enough
        // for traffic to arrive, so a positive verdict wins over a sibling's refusal.
        if (accepted?.status === "True" && resolved?.status !== "False") {
          return { kind: "programmed" };
        }
      }
      return rejected ? { kind: "rejected", reason: rejected } : { kind: "pending" };
    },

    unclaimedReason(): string {
      const section = gateway.sectionName ? ` (listener '${gateway.sectionName}')` : "";
      return (
        `no controller claimed the session HTTPRoute for Gateway ` +
        `'${gateway.namespace}/${gateway.name}'${section}. Check the Gateway exists, is programmed, ` +
        `and that a listener admits routes from namespace '${ns}' ` +
        `(spec.listeners[].allowedRoutes.namespaces).`
      );
    },
  };
}
