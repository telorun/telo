import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSessionStore } from "@telorun/runner-core";
import type { FastifyInstance } from "fastify";

import { loadRunnerConfig } from "./config.js";
import { createDockerBackend } from "./docker/backend.js";
import type { SessionDockerClient } from "./docker/docker-api.js";
import { FakeEngine } from "./docker/fake-engine.test-support.js";
import type { EngineDockerClient } from "./docker/session-container-engine.js";
import { testProcessUser } from "./docker/test-process-user.test-support.js";
import { buildServer } from "./server.js";

/** The runner as `main` builds it, over a fake engine and a store and bundle
 *  root of its own. */
export async function bootTestServer(
  docker: SessionDockerClient & EngineDockerClient = new FakeEngine().docker,
): Promise<{ app: FastifyInstance; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "docker-runner-test-"));
  const config = loadRunnerConfig({
    BUNDLE_VOLUME: "telo_runner-bundles",
    RUNNER_CHILD_NETWORK: "telo_default",
    RUNNER_STATE_DIR: join(root, "state"),
    BUNDLE_ROOT: join(root, "bundles"),
    LOG_LEVEL: "error",
  });
  const store = await openSessionStore(config.sessionStore, { log: { error() {} } });
  const backend = createDockerBackend({
    docker,
    bundleRoot: config.bundleRoot,
    bundleVolume: config.bundleVolume,
    childNetwork: config.childNetwork,
    teloImages: config.teloImages,
    workspaceImage: config.workspaceImage,
    supervisor: { build: "0123456789abcdef", subpath: ".supervisor/0123456789abcdef" },
    sessionUser: testProcessUser(),
    log: { info() {}, warn() {} },
  });
  const { app } = await buildServer({ backend, config, store });
  await app.ready();
  return {
    app,
    async close() {
      await app.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
