import { loadCoreConfig, RunnerConfigError, type RunnerCoreConfig } from "@telorun/runner-core";

export { RunnerConfigError };

export interface RunnerConfig extends RunnerCoreConfig {
  bundleRoot: string;
  bundleVolume: string;
  childNetwork: string;
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const bundleVolume = env.BUNDLE_VOLUME?.trim();
  if (!bundleVolume) {
    throw new RunnerConfigError(
      "BUNDLE_VOLUME env var is required. Set it to the daemon-visible name of the docker volume mounted at /bundles.",
    );
  }

  const childNetwork = env.RUNNER_CHILD_NETWORK?.trim();
  if (!childNetwork) {
    throw new RunnerConfigError(
      "RUNNER_CHILD_NETWORK env var is required. Set it to the docker network spawned containers should join (e.g. `bridge`, or a compose-created network name).",
    );
  }

  return {
    ...loadCoreConfig(env, { port: 8061 }),
    bundleRoot: env.BUNDLE_ROOT?.trim() || "/bundles",
    bundleVolume,
    childNetwork,
  };
}
