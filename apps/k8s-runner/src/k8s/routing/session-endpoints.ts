import type { PortMapping, RunnerEndpoint } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../../config.js";

/** Host fronting a single tcp port: `<port>-<sessionId>.<domain>`. The port rides
 *  as a leading label (no dots), so it stays a single label under the base domain
 *  — matching the docker runner's proxy scheme and compatible with a single-label
 *  wildcard cert (`*.<domain>`).
 *
 *  Shared by both routing layers on purpose: the host scheme is what a client is
 *  told and what DNS is configured for, so it must not vary with the cluster's
 *  choice of Ingress or Gateway API. */
export function hostForPort(config: K8sRunnerConfig, sessionId: string, port: number): string {
  return `${port}-${sessionId}.${config.sessionRouting.baseDomain}`;
}

/**
 * Endpoints announced on the `running` status. Every tcp port is fronted by its
 * own per-session host (served on 443) and carries an external `url`. udp ports
 * aren't HTTP-routable, so they keep the host-less form. Without a base domain,
 * host is left blank for the client adapter to fill (parity with docker).
 *
 * `routed` is what says a URL will be served, and it is separate from the base
 * domain because the two can disagree: `SESSION_ROUTING_MODE=none` with a domain
 * configured is a valid, documented setup that publishes nothing. Keying on the
 * domain alone handed the editor a URL nothing serves — and the route watch
 * never runs in that mode, so no `route` event would have said so either.
 */
export function endpointsFor(
  config: K8sRunnerConfig,
  sessionId: string,
  ports: PortMapping[],
  routed: boolean,
): RunnerEndpoint[] {
  if (!routed || !config.sessionRouting.baseDomain || ports.length === 0) {
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
