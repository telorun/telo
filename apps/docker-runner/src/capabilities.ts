import { sessionConfigSchema, type RunnerCapabilities } from "@telorun/runner-core";

/** Default image the docker-runner spawns when the client doesn't pick one. */
export const DEFAULT_SESSION_IMAGE = "telorun/node:0-slim";

export interface DockerRunnerCapabilitiesOptions {
  /** Whether the operator enabled watch sessions. */
  watch: boolean;
  /** Catalog names admissible as a session's co-resident `agent`. */
  agents?: string[];
}

/** What docker-runner advertises on `/v1/capabilities`. Image and pullPolicy
 *  are both user-editable — the docker-runner trusts the caller to pick the
 *  image. */
export function dockerRunnerCapabilities(
  opts: DockerRunnerCapabilitiesOptions,
): RunnerCapabilities {
  return {
    displayName: "Docker runner",
    description: "Runs the Application via a docker-runner HTTP service.",
    config: {
      schema: sessionConfigSchema({ imageDefault: DEFAULT_SESSION_IMAGE }),
    },
    features: {
      // Both attach modes: docker's non-TTY attach already returns a
      // multiplexed stream carrying a per-frame stream id, so `streams` invents
      // nothing at the transport layer — the TTY is what collapses it.
      io: ["tty", "streams"],
      ports: true,
      watch: opts.watch,
      ...(opts.agents && opts.agents.length > 0 ? { agents: opts.agents } : {}),
    },
  };
}
