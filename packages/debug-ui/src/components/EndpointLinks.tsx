import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import {
  type AppEndpoint,
  type EndpointReachability,
  endpointHref,
  endpointLabel,
} from "../endpoints.js";

export interface EndpointLinksProps {
  endpoints: readonly AppEndpoint[];
  /** Per-port reachability, rendered as a status icon on each tcp link. A tcp
   *  endpoint with no entry yet shows the `checking` spinner. */
  reachability?: ReadonlyMap<number, EndpointReachability>;
}

/** The running application's exposed addresses, rendered in the panel header.
 *  tcp endpoints are clickable links to the app, each carrying a reachability
 *  status icon (spinner while checking, ok/error once known); udp endpoints show
 *  as a plain label. Renders nothing when there are no endpoints. */
export function EndpointLinks({ endpoints, reachability }: EndpointLinksProps) {
  if (endpoints.length === 0) return null;
  return (
    <span className="tdbg-endpoints">
      {endpoints.map((endpoint) => {
        const label = endpointLabel(endpoint);
        const href = endpointHref(endpoint);
        const key = `${endpoint.host}:${endpoint.port}/${endpoint.protocol}`;
        if (!href) {
          return (
            <span key={key} className="tdbg-endpoint">
              {label}
            </span>
          );
        }
        return (
          <a
            key={key}
            className="tdbg-endpoint tdbg-endpoint-link"
            href={href}
            target="_blank"
            rel="noreferrer"
            title={`Open ${href}`}
          >
            {reachability && (
              <ReachabilityIcon state={reachability.get(endpoint.port) ?? "checking"} />
            )}
            {label}
            <ExternalLink size={11} aria-hidden />
          </a>
        );
      })}
    </span>
  );
}

function ReachabilityIcon({ state }: { state: EndpointReachability }) {
  if (state === "reachable") {
    return (
      <CheckCircle2
        size={11}
        className="tdbg-endpoint-status tdbg-endpoint-status--reachable"
        aria-label="reachable"
      />
    );
  }
  if (state === "unreachable") {
    return (
      <XCircle
        size={11}
        className="tdbg-endpoint-status tdbg-endpoint-status--unreachable"
        aria-label="not reachable"
      />
    );
  }
  return (
    <Loader2
      size={11}
      className="tdbg-endpoint-status tdbg-endpoint-status--checking tdbg-spin"
      aria-label="checking reachability"
    />
  );
}
