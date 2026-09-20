import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { RunnerBackend } from "../backend.js";
import type { ProbeConfig } from "../contract.js";

export interface ProbeRouteDeps {
  backend: RunnerBackend;
}

// The config is the runner's own vocabulary (see `SessionConfig`), so core
// checks that it is an object and nothing more; the backend reads the fields it
// declared on `/v1/capabilities` and reports a missing one as `needs-setup`.
const bodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    config: { type: "object" },
  },
} as const;

export function probeRoute(deps: ProbeRouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { config?: ProbeConfig } }>(
      "/v1/probe",
      { schema: { body: bodySchema } },
      async (req) => deps.backend.probe(req.body?.config ?? {}),
    );
  };
}
