import { ExternalLink } from "lucide-react";
import { type AppEndpoint, endpointHref, endpointLabel } from "../endpoints.js";

export interface EndpointLinksProps {
  endpoints: readonly AppEndpoint[];
}

/** The running application's exposed addresses, rendered in the panel header.
 *  tcp endpoints are clickable links to the app; udp endpoints show as a plain
 *  label (not reachable over http). Renders nothing when there are no endpoints. */
export function EndpointLinks({ endpoints }: EndpointLinksProps) {
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
            <ExternalLink size={11} aria-hidden />
            {label}
          </a>
        );
      })}
    </span>
  );
}
