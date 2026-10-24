import type { AvailabilityReport, RunAdapter } from "../../types";
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

  async connect(config) {
    return inner.connect(dial(config, await ensureRunning(config)));
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
