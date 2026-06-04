import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { RunnerBackend } from "../backend.js";
import type { ProbeConfig } from "../contract.js";

export interface ProbeRouteDeps {
  backend: RunnerBackend;
}

const bodySchema = {
  type: "object",
  required: ["config"],
  additionalProperties: false,
  properties: {
    config: {
      type: "object",
      required: ["image", "pullPolicy"],
      additionalProperties: false,
      properties: {
        image: { type: "string", minLength: 1 },
        pullPolicy: { type: "string", enum: ["missing", "always", "never"] },
      },
    },
  },
} as const;

export function probeRoute(deps: ProbeRouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { config: ProbeConfig } }>(
      "/v1/probe",
      { schema: { body: bodySchema } },
      async (req) => deps.backend.probe(req.body.config),
    );
  };
}
