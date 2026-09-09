import type { K8sRunnerConfig } from "../../config.js";
import type { KubeClient } from "../client.js";
import { createGatewayRouter } from "./gateway-router.js";
import { createIngressRouter } from "./ingress-router.js";
import { resolveRouting, type ResolvedRouting } from "./routing-mode.js";
import type { SessionRouter } from "./session-router.js";

export { createOrReplace } from "./create-or-replace.js";
export { buildSessionIngress } from "./ingress-router.js";
export { watchRouteHealth, type WatchRouteHealthOptions } from "./route-health.js";
export {
  detectRoutingSupport,
  resolveRouting,
  type ClusterRoutingSupport,
  type ResolvedRouting,
} from "./routing-mode.js";
export { endpointsFor, hostForPort } from "./session-endpoints.js";
export type {
  PublishedRoute,
  PublishRouteArgs,
  RouteVerdict,
  SessionRouter,
} from "./session-router.js";
export { buildSessionService, podOwnerRef, sessionObjectName } from "./session-service.js";

/**
 * Resolve the cluster's routing layer and build the router for it. Called ONCE at
 * boot: an unresolvable configuration must fail the runner rather than every
 * session it would otherwise accept and leave unroutable.
 *
 * `undefined` means logs-only — the honest answer when there is deliberately
 * nothing to publish, distinct from a failure, which throws.
 */
export async function createSessionRouter(
  kube: KubeClient,
  config: K8sRunnerConfig,
): Promise<{ router?: SessionRouter; resolved: ResolvedRouting }> {
  const resolved = await resolveRouting(kube, config);
  if (resolved.layer === "none") return { resolved };
  if (resolved.layer === "gateway") {
    return { router: createGatewayRouter(kube, config, resolved.apiVersion), resolved };
  }
  return { router: createIngressRouter(kube, config), resolved };
}
