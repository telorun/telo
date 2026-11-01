import {
  loadCoreConfig,
  requireStateDirectory,
  RunnerConfigError,
  type RunnerCoreConfig,
} from "@telorun/runner-core";
import {
  loadSessionUserFromEnv,
  loadTeloImageSource,
  type SessionUser,
  type TeloImageSource,
} from "@telorun/runner-core/container";

export { RunnerConfigError };

export interface RunnerConfig extends RunnerCoreConfig {
  bundleRoot: string;
  bundleVolume: string;
  childNetwork: string;
  /** Base URL of a host-matching proxy (e.g. Caddy) that fronts session
   *  containers by name. When set, the runner announces an absolute `url` per
   *  tcp port so studio renders a reachable link instead of falling back to
   *  the runner's own host. Unset (the default) keeps the host-less behaviour. */
  publicBaseUrl?: string;
  /** Where the kernel image of a telo version an application names comes from,
   *  and how every image the runner chooses itself is pulled
   *  (`RUNNER_TELO_IMAGE_*`, `RUNNER_PULL_POLICY`). */
  teloImages: TeloImageSource;
  /** The kernel image the runner's own workspace container runs on
   *  (`RUNNER_IMAGE`). */
  workspaceImage: string;
  /** Who every container of a session's workload runs as, and who owns the
   *  session's directory (`RUNNER_SESSION_USER`). */
  sessionUser: SessionUser;
}

/** The kernel image this runner's own containers run on unless told otherwise. */
export const DEFAULT_KERNEL_IMAGE = "telorun/node:0-slim";

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

  const core = loadCoreConfig(env, { port: 8061 });
  requireStateDirectory(core.sessionStore);

  return {
    ...core,
    bundleRoot: env.BUNDLE_ROOT?.trim() || "/bundles",
    bundleVolume,
    childNetwork,
    publicBaseUrl,
    teloImages: loadTeloImageSource(env),
    workspaceImage: env.RUNNER_IMAGE?.trim() || DEFAULT_KERNEL_IMAGE,
    sessionUser: loadSessionUserFromEnv(env),
  };
}
