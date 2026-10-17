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
 * Every host one tcp port is served on: its own, then each public address the
 * kernel announced for it that this session's templates derived — a single label
 * ending in `-<sessionId>.<domain>`, so the wildcard certificate still covers it.
 * An announced host outside that suffix came from the session's own env, and is
 * its author's to route; one that is a port's own host (an all-digit label) is
 * never routed beside another port, so one hostname never reaches two ports.
 */
export function hostsForPort(
  config: K8sRunnerConfig,
  sessionId: string,
  port: PortMapping,
  sessionPorts: readonly PortMapping[],
): string[] {
  const own = hostForPort(config, sessionId, port.port);
  const portHosts = new Set(sessionPorts.map((p) => hostForPort(config, sessionId, p.port)));
  const suffix = `-${sessionId}.${config.sessionRouting.baseDomain}`;
  const derived = (port.publicHosts ?? []).filter((host) => {
    if (host === own || portHosts.has(host) || !host.endsWith(suffix)) return false;
    const label = host.slice(0, host.length - suffix.length);
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && !/^[0-9]+$/.test(label);
  });
  return [own, ...new Set(derived)];
}

/**
 * The host values a routed session's application answers its `Telo.PublicUrl`
 * needs from: each port's own host for the primary, and — where the runner
 * routes what the kernel announces, a watch session — `<label>--<port>-…` for
 * every other address on a port.
 */
export function publicUrlTemplateEnv(
  config: K8sRunnerConfig,
  sessionId: string,
  routesAnnounced: boolean,
): Record<string, string> {
  const domain = config.sessionRouting.baseDomain;
  if (!domain) return {};
  return {
    TELO_HOST_PUBLIC_URL_TEMPLATE: `https://{port}-${sessionId}.${domain}`,
    ...(routesAnnounced
      ? { TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE: `https://{label}--{port}-${sessionId}.${domain}` }
      : {}),
  };
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
