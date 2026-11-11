import type { RunnerEndpoint } from "./types";

/** What the runner's `openUrl` event says, as far as Studio reads it. */
export interface OpenUrlEvent {
  app: string;
  generation: number;
  url: string;
  reach: "port" | "unrouted" | "external";
  port?: number;
}

/** One request an app made to open a page, as shown to the user. */
export interface OpenUrlRequest {
  /** `<record id>|<address>`: the same address in the same run is one request. */
  id: string;
  recordId: string;
  appPath: string;
  app: string;
  reach: OpenUrlEvent["reach"];
  /** The address to open (for `unrouted`, the address the app asked for). */
  address: string;
  /** The host the address names, shown prominently for an external one. */
  host: string;
  /** `confirm` asks in a dialog; `notice` is a link in the run dock. */
  mode: "confirm" | "notice";
}

export type OpenAddress = { kind: "ready"; address: string; host: string } | { kind: "waiting" } | { kind: "refused"; reason: string };

/** The URL when it is an absolute `http:` / `https:` one, else null. */
export function parseWebUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The address a client can open for a request. A `port` request is translated
 * through the run's endpoint for that port — its `url` when it has one, else
 * the request's scheme with the endpoint's host (an empty one is the runner's
 * own host) and port — keeping the request's path, query and fragment, and is
 * `waiting` until that endpoint is known; the runner-internal address is never
 * returned. An `external` one is the runner's serialization, re-parsed; so is an
 * `unrouted` one, which the caller shows and never opens.
 */
export function openAddressFor(event: OpenUrlEvent, endpoints: readonly RunnerEndpoint[], runnerBaseUrl: string | null): OpenAddress {
  const requested = parseWebUrl(event.url);
  if (!requested) return { kind: "refused", reason: "the address is not an http or https URL" };

  if (event.reach !== "port") return { kind: "ready", address: requested.href, host: requested.host };

  const endpoint = endpoints.find((e) => e.protocol === "tcp" && e.port === event.port);
  if (!endpoint) return { kind: "waiting" };

  const target = endpoint.url ? endpointTarget(endpoint.url, requested) : hostedTarget(endpoint, requested, runnerBaseUrl);
  if (!target) return { kind: "waiting" };
  return { kind: "ready", address: target.href, host: target.host };
}

function endpointTarget(endpointUrl: string, requested: URL): URL | null {
  const base = parseWebUrl(endpointUrl);
  if (!base) return null;
  const target = new URL(base.origin);
  target.pathname = base.pathname.replace(/\/+$/, "") + requested.pathname;
  target.search = requested.search;
  target.hash = requested.hash;
  return target;
}

function hostedTarget(endpoint: RunnerEndpoint, requested: URL, runnerBaseUrl: string | null): URL | null {
  const host = endpoint.host !== "" ? endpoint.host : runnerBaseUrl ? hostnameOf(runnerBaseUrl) : null;
  if (!host) return null;
  const target = new URL(requested.href);
  target.username = "";
  target.password = "";
  target.hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  target.port = String(endpoint.port);
  return target;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
