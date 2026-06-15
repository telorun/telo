import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { RunnerCapabilities } from "../contract.js";

/** Advertises the runner's self-description + editable config schema, so the
 *  editor can render a generic runner config form without hardcoding per-backend
 *  fields. The document is backend-authored — each concrete runner supplies its
 *  own `RunnerCapabilities`; core only serves it.
 *
 *  Accepts a getter as well as a static document so a runner whose config
 *  surface changes at runtime (e.g. a base-image catalog refreshed from a
 *  registry) is re-resolved on each request rather than frozen at boot. */
export function capabilitiesRoute(
  capabilities: RunnerCapabilities | (() => RunnerCapabilities),
): FastifyPluginAsync {
  const resolve = typeof capabilities === "function" ? capabilities : () => capabilities;
  return async (app: FastifyInstance) => {
    app.get("/v1/capabilities", async () => resolve());
  };
}
