import type {
  AvailabilityAction,
  AvailabilityReport,
  ConfigIssue,
  RunAdapter,
  RunSession,
} from "../../types";
import { createHttpRunnerAdapter } from "../http-runner/factory";
import {
  localDockerConfigSchema,
  localDockerDefaultConfig,
  type LocalDockerConfig,
} from "./config-schema";
import { LOCAL_RUNNER_IMAGE } from "./runner-image";
import { localRunnerStatus, probeDocker, startLocalRunner } from "./supervisor";

const DISPLAY_NAME = "Local (docker)";
const DESCRIPTION =
  "Runs the Application on a docker-runner container the editor manages on this machine.";

export const NOT_RUNNING_MESSAGE = "The local Docker runner is not running.";

/** The wire half: a plain http-runner adapter dialing the supervisor-managed
 *  baseUrl. All session/SSE/PTY logic is the shared factory's — this file only
 *  decides where `baseUrl` comes from and gates on the runner being up. */
const inner = createHttpRunnerAdapter<LocalDockerConfig & { baseUrl: string }>({
  id: "local-docker",
  displayName: DISPLAY_NAME,
  description: DESCRIPTION,
  configSchema: localDockerConfigSchema,
  defaultConfig: { ...localDockerDefaultConfig, baseUrl: "" },
  startTimeoutMs: 120_000,
  buildRequestConfig(config) {
    const { baseUrl: _baseUrl, ...rest } = config;
    return rest;
  },
});

function dial(config: LocalDockerConfig, baseUrl: string): LocalDockerConfig & { baseUrl: string } {
  return { ...config, baseUrl };
}

/** The user-facing consent gate: starting is an explicit action whose
 *  consequences are stated up front, per the local-runner-supervisor plan. */
function startAction(): AvailabilityAction {
  return {
    label: "Start local runner",
    description:
      `Starts a telo runner in a Docker container on this machine (first start downloads ` +
      `${LOCAL_RUNNER_IMAGE}). The runner has access to your Docker daemon — it runs each ` +
      `Application as its own container — and listens on 127.0.0.1 without authentication. ` +
      `It is stopped and removed when the editor quits.`,
    async run() {
      await startLocalRunner();
    },
  };
}

export const localDockerAdapter: RunAdapter<LocalDockerConfig> = {
  id: "local-docker",
  displayName: DISPLAY_NAME,
  description: DESCRIPTION,

  configSchema: localDockerConfigSchema,
  defaultConfig: localDockerDefaultConfig,

  validateConfig(config) {
    const issues: ConfigIssue[] = [];
    if (!config.image || config.image.trim() === "") {
      issues.push({ path: "/image", message: "Image name is required." });
    }
    return issues;
  },

  async fetchCapabilities(config) {
    const status = await localRunnerStatus();
    if (status.state !== "ready" || !status.baseUrl) return null;
    return inner.fetchCapabilities!(dial(config, status.baseUrl));
  },

  async isAvailable(config): Promise<AvailabilityReport> {
    const docker = await probeDocker();
    if (docker.status !== "ready") return docker;
    const status = await localRunnerStatus();
    if (status.state === "starting") {
      return { status: "unavailable", message: "The local runner is starting…" };
    }
    if (status.state !== "ready" || !status.baseUrl) {
      return { status: "unavailable", message: NOT_RUNNING_MESSAGE, action: startAction() };
    }
    return inner.isAvailable(dial(config, status.baseUrl));
  },

  async start(request, config): Promise<RunSession> {
    // Never boots the runner — starting it is an explicit user action.
    const status = await localRunnerStatus();
    if (status.state !== "ready" || !status.baseUrl) {
      throw new Error(`${NOT_RUNNING_MESSAGE} Start it from the run panel or Settings.`);
    }
    return inner.start(request, dial(config, status.baseUrl));
  },

  async attach(sessionId, config): Promise<RunSession | null> {
    // Kill-on-close means sessions never outlive the editor process; when the
    // runner is down the recorded session is gone for good.
    const status = await localRunnerStatus();
    if (status.state !== "ready" || !status.baseUrl) return null;
    return inner.attach!(sessionId, dial(config, status.baseUrl));
  },

  async resolveBaseUrl() {
    const status = await localRunnerStatus();
    return status.state === "ready" ? (status.baseUrl ?? null) : null;
  },
};
