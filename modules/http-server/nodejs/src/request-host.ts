import { normalizeRequestHost } from "@telorun/http-dispatch";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";

/**
 * The one host a request is routed, documented and logged by: `Host` (or
 * `:authority` on HTTP/2), lowercased, its port and a trailing dot dropped —
 * replaced by `X-Forwarded-Host` only when the server trusts the proxy in front.
 *
 * `Http.Server` decides whether the proxy is trusted and publishes its reader on
 * the Fastify instance, so a mount reads the same host without a handle on the
 * server resource.
 */
export type RequestHostReader = (raw: IncomingMessage) => string;

const REQUEST_HOST = "teloRequestHost";

export function requestHostReader(trustsProxy: boolean): RequestHostReader {
  return (raw) => {
    const forwarded = trustsProxy ? lastHeaderValue(raw.headers["x-forwarded-host"]) : undefined;
    const authority = raw.headers[":authority" as "host"] as string | undefined;
    return normalizeRequestHost(forwarded ?? raw.headers.host ?? authority ?? "");
  };
}

/** The value the nearest proxy wrote: the last of a comma-separated list. */
function lastHeaderValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[value.length - 1] : value;
  if (text === undefined || text.trim() === "") return undefined;
  const parts = text.split(",");
  return parts[parts.length - 1]!.trim();
}

export function publishRequestHost(app: FastifyInstance, reader: RequestHostReader): void {
  app.decorate(REQUEST_HOST, reader);
}

/** The request's host as the server that registered `app` reads it. */
export function requestHostOf(app: FastifyInstance, request: FastifyRequest): string {
  const reader = (app as unknown as Record<string, unknown>)[REQUEST_HOST] as RequestHostReader | undefined;
  return reader ? reader(request.raw) : normalizeRequestHost(request.hostname ?? "");
}
