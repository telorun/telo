import type { BackendSession, BackendStartSpec, RunnerBackend } from "@telorun/runner-core";

import { BundleWorkdir } from "./bundle-workdir.js";
import { runProbe, type ProbeDockerClient } from "./probe.js";
import { spawnDockerSession, type SessionDockerClient } from "./run-session.js";

export interface DockerBackendDeps {
  docker: SessionDockerClient & ProbeDockerClient;
  bundleRoot: string;
  bundleVolume: string;
  childNetwork: string;
  publicBaseUrl?: string;
}

/**
 * The docker `RunnerBackend`: delivers the bundle to a per-session directory on
 * the shared volume, then spawns a sibling container and adapts its hijacked
 * attach duplex onto `BackendSession`. Orphan cleanup is handled at boot by
 * `sweepOrphanBundles` (containers are `--rm`'d by the daemon), so no
 * `reapOrphans` here.
 */
export function createDockerBackend(deps: DockerBackendDeps): RunnerBackend {
  return {
    async probe(config) {
      return runProbe(
        deps.docker,
        { bundleVolume: deps.bundleVolume, childNetwork: deps.childNetwork },
        config,
      );
    },

    async start(spec: BackendStartSpec): Promise<BackendSession> {
      const containerName = `telo-run-${spec.sessionId}`;
      const workingDir = `/srv/${spec.sessionId}`;

      // App session: the operator-catalog image is self-contained — app +
      // controllers baked in — so there's no bundle to stage; launch the
      // image's own CMD. The core session route already resolved the image and
      // merged the operator env from the app catalog.
      if (spec.selfContained) {
        return spawnDockerSession({
          docker: deps.docker,
          containerName,
          sessionId: spec.sessionId,
          image: spec.config.image,
          pullPolicy: spec.config.pullPolicy,
          entryRelativePath: "",
          workingDir: "",
          env: spec.env,
          ports: spec.ports,
          publicBaseUrl: deps.publicBaseUrl,
          bundleVolume: deps.bundleVolume,
          childNetwork: deps.childNetwork,
          inspect: false,
          selfContained: true,
          onStatus: spec.onStatus,
          onOutput: spec.onOutput,
          onDebug: spec.onDebug,
          onReachability: spec.onReachability,
          isUserStopped: spec.isUserStopped,
        });
      }

      let workdir: BundleWorkdir | null = null;
      try {
        workdir = await BundleWorkdir.create(deps.bundleRoot, spec.sessionId, spec.bundle);
        return await spawnDockerSession({
          docker: deps.docker,
          containerName,
          sessionId: spec.sessionId,
          image: spec.config.image,
          pullPolicy: spec.config.pullPolicy,
          entryRelativePath: `./${spec.entryRelativePath}`,
          workingDir,
          env: spec.env,
          ports: spec.ports,
          publicBaseUrl: deps.publicBaseUrl,
          bundleVolume: deps.bundleVolume,
          childNetwork: deps.childNetwork,
          inspect: spec.inspect,
          onStatus: spec.onStatus,
          onOutput: spec.onOutput,
          onDebug: spec.onDebug,
          onReachability: spec.onReachability,
          isUserStopped: spec.isUserStopped,
        });
      } catch (err) {
        if (workdir) {
          await workdir.cleanup().catch(() => {
            /* best-effort cleanup on start failure */
          });
        }
        throw err;
      }
    },
  };
}
