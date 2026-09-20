import type { AvailabilityReport, RunAdapter, RunSession } from "../../types";
import { createHttpRunnerAdapter } from "../http-runner/factory";
import {
  localCliConfigSchema,
  localCliDefaultConfig,
  type LocalCliConfig,
} from "./config-schema";
import {
  localCliRunnerStatus,
  probeCli,
  startLocalCliRunner,
  stopLocalCliRunner,
} from "./supervisor";

const DISPLAY_NAME = "Local (telo CLI)";
const DESCRIPTION =
  "Runs the Application with the telo CLI on this machine — one process per application, no container.";

/** The wire half: a plain http-runner adapter dialing the supervisor-managed
 *  baseUrl. Every session, SSE and byte-channel concern is the shared factory's
 *  — this file only decides where `baseUrl` comes from and when the runner is
 *  started. */
const inner = createHttpRunnerAdapter<LocalCliConfig & { baseUrl: string }>({
  id: "local-cli",
  displayName: DISPLAY_NAME,
  description: DESCRIPTION,
  configSchema: localCliConfigSchema,
  defaultConfig: { ...localCliDefaultConfig, baseUrl: "" },
  startTimeoutMs: 120_000,
  buildRequestConfig() {
    // The runner advertises no editable session fields, and `executable` is the
    // editor's own answer about which runner to start — not something the wire
    // carries.
    return {};
  },
});

function dial(config: LocalCliConfig, baseUrl: string): LocalCliConfig & { baseUrl: string } {
  return { ...config, baseUrl };
}

/**
 * Bring the runner up if it is not already.
 *
 * Unlike the docker runner this needs no consent gate: that gate exists because
 * the docker runner mounts the daemon socket and can create containers on this
 * machine. Running the user's own application as the user's own process, from
 * the editor they launched, asks for nothing they have not already granted.
 */
async function ensureRunning(config: LocalCliConfig): Promise<string> {
  const status = await localCliRunnerStatus();
  if (status.state === "ready" && status.baseUrl) return status.baseUrl;
  return startLocalCliRunner(config.executable);
}

export const localCliAdapter: RunAdapter<LocalCliConfig> = {
  id: "local-cli",
  displayName: DISPLAY_NAME,
  description: DESCRIPTION,

  configSchema: localCliConfigSchema,
  defaultConfig: localCliDefaultConfig,

  validateConfig() {
    // Nothing to validate: the only field is an optional path, and whether it
    // exists is the supervisor's answer (it resolves the sidecar too), reported
    // through `isAvailable` rather than guessed at from this string.
    return [];
  },

  async fetchCapabilities(config) {
    // Only when the runner happens to be up: rendering a settings form is not a
    // reason to start a process, and the static schema above is the whole
    // surface anyway.
    const status = await localCliRunnerStatus();
    if (status.state !== "ready" || !status.baseUrl) return null;
    return inner.fetchCapabilities!(dial(config, status.baseUrl));
  },

  async isAvailable(config): Promise<AvailabilityReport> {
    // Available means "this runner can run your application", and a stopped
    // runner still can — Run starts it. What it cannot survive is having no
    // telo to run at all, which is what the probe answers.
    const cli = await probeCli(config.executable);
    if (cli.status !== "ready") return cli;
    const status = await localCliRunnerStatus();
    if (status.state === "starting") {
      return { status: "unavailable", message: "The local runner is starting…" };
    }
    if (status.state !== "ready" || !status.baseUrl) return { status: "ready" };
    return inner.isAvailable(dial(config, status.baseUrl));
  },

  async start(request, config): Promise<RunSession> {
    const baseUrl = await ensureRunning(config);
    return inner.start(request, dial(config, baseUrl));
  },

  async attach(sessionId, config): Promise<RunSession | null> {
    // The runner stops every session when the editor quits, so a session
    // recorded against a runner that is down is gone for good — and starting
    // one to ask would prove nothing.
    const status = await localCliRunnerStatus();
    if (status.state !== "ready" || !status.baseUrl) return null;
    return inner.attach!(sessionId, dial(config, status.baseUrl));
  },

  async probeSession(sessionId, config) {
    const status = await localCliRunnerStatus();
    if (status.state !== "ready" || !status.baseUrl) return null;
    return inner.probeSession!(sessionId, dial(config, status.baseUrl));
  },

  async stopSession(sessionId, config) {
    // Nothing left to stop: the runner that held it is gone, and it took its
    // sessions with it. Resolving rather than throwing keeps Stop honest.
    const status = await localCliRunnerStatus();
    if (status.state !== "ready" || !status.baseUrl) return;
    await inner.stopSession!(sessionId, dial(config, status.baseUrl));
  },

  async isRunning() {
    return (await localCliRunnerStatus()).state === "ready";
  },

  async teardown() {
    await stopLocalCliRunner();
  },

  async resolveBaseUrl() {
    const status = await localCliRunnerStatus();
    return status.state === "ready" ? (status.baseUrl ?? null) : null;
  },
};
