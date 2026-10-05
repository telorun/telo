import type { BackendSession, BackendStartSpec, RunnerBackend } from "@telorun/runner-core";
import {
  appContainerConfig,
  teloImageRefusal,
  type TeloImageSource,
} from "@telorun/runner-core/container";

import { BundleWorkdir } from "./bundle-workdir.js";
import { runProbe, type ProbeDockerClient } from "./probe.js";
import { spawnDockerSession, type SessionDockerClient } from "./run-session.js";
import { startDockerWatchSession } from "./watch-session.js";

export interface DockerBackendDeps {
  docker: SessionDockerClient & ProbeDockerClient;
  bundleRoot: string;
  bundleVolume: string;
  childNetwork: string;
  publicBaseUrl?: string;
  /** Wall-clock ceiling for a watch session (docker has no pod deadline). */
  watchMaxTtlSeconds: number;
  /** Where the kernel image of a requested telo version is pulled from. */
  teloImages: TeloImageSource;
  /** The kernel image the runner's own workspace container runs on. The
   *  operator's, never the session's: that container serves the runner's
   *  manifest, which is verified against the kernel the runner was built with. */
  workspaceImage: string;
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

    // Only what is certain without touching a registry. The pull itself is
    // start's: it can take minutes, and start is where progress, cancellation
    // and the session ceilings already are — an image that cannot be pulled
    // fails the session on its stream, naming the image.
    async supplyTelo(version) {
      return teloImageRefusal(version, deps.teloImages);
    },

    async start(spec: BackendStartSpec): Promise<BackendSession> {
      // A watch session is a different container topology and a different
      // lifetime — it outlives its runs — so it takes its own path rather than
      // accreting branches through this one.
      if (spec.mode === "watch") {
        return startDockerWatchSession(
          {
            docker: deps.docker,
            bundleRoot: deps.bundleRoot,
            bundleVolume: deps.bundleVolume,
            childNetwork: deps.childNetwork,
            publicBaseUrl: deps.publicBaseUrl,
            maxTtlSeconds: deps.watchMaxTtlSeconds,
            teloImages: deps.teloImages,
            workspaceImage: deps.workspaceImage,
          },
          spec,
        );
      }

      // The session config is the runner's own vocabulary, so it is narrowed
      // here rather than read field-by-field off the contract.
      const containerName = `telo-run-${spec.sessionId}`;
      const workingDir = `/srv/${spec.sessionId}`;
      // A run session is one application by construction — `apps` carries
      // exactly one entry, defaulted by core when the request declared none.
      const app = spec.apps[0]!;
      const image = appContainerConfig(spec.config, app.telo, deps.teloImages);

      // App session: the operator-catalog image is self-contained — app +
      // controllers baked in — so there's no bundle to stage; launch the
      // image's own CMD. The core session route already resolved the image and
      // merged the operator env from the app catalog.
      if (spec.selfContained) {
        return spawnDockerSession({
          docker: deps.docker,
          containerName,
          sessionId: spec.sessionId,
          image: image.image,
          pullPolicy: image.pullPolicy,
          entryRelativePath: "",
          workingDir: "",
          env: spec.env,
          ports: app.ports,
          publicBaseUrl: deps.publicBaseUrl,
          bundleVolume: deps.bundleVolume,
          childNetwork: deps.childNetwork,
          inspect: false,
          selfContained: true,
          appName: app.name,
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
          image: image.image,
          pullPolicy: image.pullPolicy,
          entryRelativePath: `./${app.entryRelativePath}`,
          workingDir,
          env: spec.env,
          ports: app.ports,
          publicBaseUrl: deps.publicBaseUrl,
          bundleVolume: deps.bundleVolume,
          childNetwork: deps.childNetwork,
          inspect: spec.inspect,
          appName: app.name,
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
