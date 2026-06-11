import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { RunnerCapabilities } from "../contract.js";

/** Advertises the runner's self-description + editable config schema, so the
 *  editor can render a generic runner config form without hardcoding per-backend
 *  fields. The document is backend-authored — each concrete runner supplies its
 *  own `RunnerCapabilities`; core only serves it. */
export function capabilitiesRoute(capabilities: RunnerCapabilities): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.get("/v1/capabilities", async () => capabilities);
  };
}
