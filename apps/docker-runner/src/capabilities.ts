import { sessionConfigSchema, type RunnerCapabilities } from "@telorun/runner-core";

/** Default image the docker-runner spawns when the client doesn't pick one. */
export const DEFAULT_SESSION_IMAGE = "telorun/node:0-slim";

/** What docker-runner advertises on `/v1/capabilities`. Image / pullPolicy /
 *  registryUrl are all user-editable — the docker-runner trusts the caller to
 *  pick the image. */
export const dockerRunnerCapabilities: RunnerCapabilities = {
  displayName: "Docker runner",
  description: "Runs the Application via a docker-runner HTTP service.",
  config: {
    schema: sessionConfigSchema({ imageDefault: DEFAULT_SESSION_IMAGE, registryUrl: true }),
  },
  features: { io: true, ports: true },
};
