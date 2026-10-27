import { loadAgentFromEnv, RunnerConfigError, type RunnerAgent } from "@telorun/runner-core";

/**
 * The co-resident agent `telo runner` offers, from the `AGENT_*` variables. It
 * runs as a `telo run` process, so only `AGENT_MODULE_REF` names one; an
 * `AGENT_IMAGE` is refused at boot rather than advertised and failed per session.
 */
export function loadLocalAgent(env: NodeJS.ProcessEnv): RunnerAgent | undefined {
  const agent = loadAgentFromEnv(env);
  if (agent?.source.kind === "image") {
    throw new RunnerConfigError(
      `AGENT_IMAGE is set ('${agent.source.image}'), but this runner runs no container images — ` +
        "set AGENT_MODULE_REF to the agent's module (an oci:// reference or an absolute path) instead.",
    );
  }
  return agent;
}
