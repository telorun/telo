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

/** Per-port reachability of a running app's endpoint, surfaced as a status icon
 *  beside the link: a spinner while `checking`, ok when `reachable`, error when
 *  `unreachable`. Mirrors the runner contract's `ReachabilityState`, kept local so
 *  debug-ui stays browser-safe with no dependency on the runner package. */
export type EndpointReachability = "checking" | "reachable" | "unreachable";

/** The link a tcp endpoint resolves to, or `null` for a non-linkable (udp)
 *  endpoint. Prefers an explicit `url`; otherwise derives `http://host:port`. */
export function endpointHref(endpoint: AppEndpoint): string | null {
  if (endpoint.url) return endpoint.url;
  if (endpoint.protocol !== "tcp") return null;
  return `http://${formatHost(endpoint.host)}:${endpoint.port}`;
}

/** Display label for an endpoint, e.g. `localhost:8080` or `:9000/udp`. When the
 *  endpoint carries an absolute `url`, label with that url's authority so the text
 *  matches the link actually opened — `host`/`port` may be display-only values
 *  (e.g. a proxy/ingress whose `host` isn't itself routable). */
export function endpointLabel(endpoint: AppEndpoint): string {
  if (endpoint.url) {
    try {
      return new URL(endpoint.url).host;
    } catch {
      // Malformed url — fall back to host:port below.
    }
  }
  const host = endpoint.host ? formatHost(endpoint.host) : "";
  const base = `${host}:${endpoint.port}`;
  return endpoint.protocol === "tcp" ? base : `${base}/udp`;
}

/** IPv6 literals need bracketing when paired with a port. */
function formatHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}
