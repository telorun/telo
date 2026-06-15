import { loadCoreConfig, RunnerConfigError, type RunnerCoreConfig } from "@telorun/runner-core";

export { RunnerConfigError };

export interface RunnerConfig extends RunnerCoreConfig {
  bundleRoot: string;
  bundleVolume: string;
  childNetwork: string;
  /** Base URL of a host-matching proxy (e.g. Caddy) that fronts session
   *  containers by name. When set, the runner announces an absolute `url` per
   *  tcp port so the editor renders a reachable link instead of falling back to
   *  the runner's own host. Unset (the default) keeps the host-less behaviour. */
  publicBaseUrl?: string;
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

  const publicBaseUrl = env.RUNNER_PUBLIC_BASE_URL?.trim() || undefined;
  if (publicBaseUrl) {
    try {
      new URL(publicBaseUrl);
    } catch {
      throw new RunnerConfigError(
        `RUNNER_PUBLIC_BASE_URL must be a valid URL, e.g. http://run.telo.localhost:8060, got '${publicBaseUrl}'.`,
      );
    }
  }

  return {
    ...loadCoreConfig(env, { port: 8061 }),
    bundleRoot: env.BUNDLE_ROOT?.trim() || "/bundles",
    bundleVolume,
    childNetwork,
    publicBaseUrl,
  };
}
