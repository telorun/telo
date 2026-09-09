import type { PortMapping } from "@telorun/runner-core";

/** One published host and the session port behind it. */
export interface PublishedRoute {
  host: string;
  port: number;
}

export interface PublishRouteArgs {
  sessionId: string;
  /** The Service the routing object points at. */
  serviceName: string;
  /** Owner of every object created — see `podOwnerRef`. */
  podName: string;
  podUid: string;
  /** Every port the session must carry. Non-tcp ports are ignored: they are not
   *  HTTP-routable, and the Service still exposes them. */
  ports: PortMapping[];
}

/**
 * What a routing layer has to say about one published host.
 *
 * `pending` is a real answer, not an absence: a controller that has not yet
 * written status is indistinguishable from one that will never claim the route,
 * and only time separates them.
 */
export type RouteVerdict =
  | { kind: "programmed" }
  | { kind: "pending" }
  | { kind: "rejected"; reason: string };

/**
 * How this cluster publishes a session's public routes.
 *
 * The seam exists because Ingress and Gateway API are both current: neither is a
 * migration target for the other, clusters ship one, the other, or both, and a
 * runner that hardcodes either is unroutable on half of them. It deliberately
 * stays inside the k8s backend — docker publishes host ports through its own
 * proxy and has no use for it, and `runner-core` owns the backend-neutral `/v1`
 * contract, where "Ingress or HTTPRoute" is not a distinction that exists.
 */
export interface SessionRouter {
  /** Names the layer for diagnostics. */
  readonly layer: "ingress" | "gateway";

  /** Create-or-replace this session's routing objects. Returns the hosts it
   *  published, which is what the route watch then asks about. */
  publish(args: PublishRouteArgs): Promise<PublishedRoute[]>;

  /** This layer's current verdict on one published host. Asked repeatedly by the
   *  route watch until it settles or the deadline passes. */
  verdictFor(sessionId: string, route: PublishedRoute): Promise<RouteVerdict>;

  /** What to tell an operator when a route is still `pending` at the deadline.
   *  Layer-specific because the causes are: no controller for the IngressClass,
   *  versus a Gateway that never claimed the route. */
  unclaimedReason(): string;
}
