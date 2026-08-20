import type { FastifyInstance } from "fastify";

/**
 * The `servers:` array of the OpenAPI document as it is SERVED, which neither
 * half of the docs can decide alone.
 *
 * `Http.Server` owns the policy — it holds `baseUrl` and knows whether forwarded
 * headers are trusted — while `Http.Reference` owns the route the document is
 * served from, so the rewrite is installed by the mount and decided by the
 * server. The server publishes its decision as a Fastify decorator rather than
 * passing it down a ref: a mount is reached through `register(app, prefix)` and
 * has no handle on the server resource.
 */
const SPEC_SERVER_URL_PER_REQUEST = "teloOpenapiSpecServerUrlPerRequest";

/** Declare whether the served document's server URL must be rebuilt per request
 *  (a trusted proxy in front, and no fixed `baseUrl` to state instead). */
export function publishSpecServerUrlPolicy(app: FastifyInstance, perRequest: boolean): void {
  app.decorate(SPEC_SERVER_URL_PER_REQUEST, perRequest);
}

/** The policy the server published, absent when it declared no `openapi:` block. */
export function specServerUrlIsPerRequest(app: FastifyInstance): boolean {
  return (app as unknown as Record<string, unknown>)[SPEC_SERVER_URL_PER_REQUEST] === true;
}

/**
 * Rewrite the served document's `servers:` to the URL this request arrived on.
 *
 * The registered document declares a relative server URL (`/`), which is correct
 * behind any origin because the client resolves it against wherever the reference
 * was loaded. With a trusted proxy in front, the real URL is knowable per request
 * from the now-trusted `X-Forwarded-*` headers, so the served document advertises
 * it instead of leaving the client to infer it.
 */
export function installSpecServerUrlRewrite(app: FastifyInstance, specPath: string): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.split("?")[0] !== specPath) return payload;
    const text =
      typeof payload === "string"
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString("utf8")
          : null;
    if (text === null) return payload;
    try {
      const doc = JSON.parse(text);
      if (doc && typeof doc === "object" && Array.isArray(doc.servers)) {
        doc.servers = [{ url: `${request.protocol}://${request.host}` }];
        const out = JSON.stringify(doc);
        reply.header("content-length", Buffer.byteLength(out));
        return out;
      }
    } catch {
      // Not a JSON document we can rewrite — leave the response untouched.
    }
    return payload;
  });
}
