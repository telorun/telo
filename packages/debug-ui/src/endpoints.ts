/** A reachable address of the running application, surfaced as a link in the
 *  debug panel header. Structurally matches the editor's `RunnerEndpoint` and the
 *  runner contract's endpoint, but kept local to debug-ui so this package stays
 *  browser-safe with no dependency on the Node-only runner / kernel packages. */
export interface AppEndpoint {
  /** Reachable host. May be empty when the producer can't know which hostname the
   *  viewer used; {@link DebugWatcher} fills it from the page origin. */
  host: string;
  port: number;
  protocol: "tcp" | "udp";
  /** Fully-qualified URL when the producer already knows it (proxy / ingress);
   *  preferred over deriving `http://host:port`. */
  url?: string;
}

/** The link a tcp endpoint resolves to, or `null` for a non-linkable (udp)
 *  endpoint. Prefers an explicit `url`; otherwise derives `http://host:port`. */
export function endpointHref(endpoint: AppEndpoint): string | null {
  if (endpoint.url) return endpoint.url;
  if (endpoint.protocol !== "tcp") return null;
  return `http://${formatHost(endpoint.host)}:${endpoint.port}`;
}

/** Display label for an endpoint, e.g. `localhost:8080` or `:9000/udp`. */
export function endpointLabel(endpoint: AppEndpoint): string {
  const host = endpoint.host ? formatHost(endpoint.host) : "";
  const base = `${host}:${endpoint.port}`;
  return endpoint.protocol === "tcp" ? base : `${base}/udp`;
}

/** IPv6 literals need bracketing when paired with a port. */
function formatHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}
