import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { RunnerConfig } from "../config.js";
import { runProbe, type ProbeDockerClient } from "../docker/probe.js";
import type { ProbeConfig } from "../types.js";

export interface ProbeRouteDeps {
  docker: ProbeDockerClient;
  runnerConfig: Pick<RunnerConfig, "bundleVolume" | "childNetwork">;
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
      async (req) => runProbe(deps.docker, deps.runnerConfig, req.body.config),
    );
  };
}
