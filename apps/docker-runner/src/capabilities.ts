import type { RunnerCapabilities } from "@telorun/runner-core";
import { sessionConfigSchema, SUPERSEDED_BY_TELO } from "@telorun/runner-core/container";

import { DEFAULT_KERNEL_IMAGE } from "./config.js";

/** Default image the docker-runner spawns when the client doesn't pick one. */
export const DEFAULT_SESSION_IMAGE = DEFAULT_KERNEL_IMAGE;

export interface DockerRunnerCapabilitiesOptions {
  /** Catalog names admissible as a session's co-resident `agent`. */
  agents?: string[];
}

/** What docker-runner advertises on `/v1/capabilities`. */
export function dockerRunnerCapabilities(
  opts: DockerRunnerCapabilitiesOptions,
): RunnerCapabilities {
  return {
    displayName: "Docker runner",
    description: "Runs the Application via a docker-runner HTTP service.",
    config: {
      // `image` and `pullPolicy` are what a client naming no telo version still
      // sends; the version an application names chooses its image, pulled under
      // the operator's policy.
      schema: sessionConfigSchema({ imageDefault: DEFAULT_SESSION_IMAGE, teloVersions: true }),
      supersededByTelo: SUPERSEDED_BY_TELO,
    },
    features: {
      // The session supervisor gives each run a fresh pty or separate pipes.
      io: ["tty", "streams"],
      ports: true,
      teloVersions: true,
      ...(opts.agents && opts.agents.length > 0 ? { agents: opts.agents } : {}),
    },
  };
}
