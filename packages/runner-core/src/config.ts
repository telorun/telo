import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { RunnerTerms } from "./contract.js";

/**
 * Backend-neutral runner configuration. Concrete runners (docker, k8s) extend
 * `RunnerCoreConfig` with their own fields and reuse these parse helpers so
 * config validation and error reporting stay identical across backends.
 */
export interface RunnerCoreConfig {
  port: number;
  logLevel: string;
  maxSessions: number;
  exitTtlMs: number;
  replayBufferBytes: number;
  corsOrigins: string[] | "*";
}

export class RunnerConfigError extends Error {}

export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  field: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new RunnerConfigError(`${field} must be a positive integer, got '${raw}'.`);
  }
  return n;
}

export function parsePort(raw: string | undefined, fallback: number): number {
  const portStr = raw ?? String(fallback);
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RunnerConfigError(`PORT must be an integer in 1..65535, got '${portStr}'.`);
  }
  return port;
}

/**
 * Build the runner's usage terms from the environment. Terms are opt-in: returns
 * `undefined` (no gate) unless a non-empty body is provided.
 *
 * The body comes from `RUNNER_TERMS_FILE` (a path read at startup — the natural
 * fit for a k8s ConfigMap mount or a bind-mounted file) or, for short notes,
 * inline `RUNNER_TERMS_BODY`. `RUNNER_TERMS_VERSION` is optional and defaults to
 * a short hash of the body, so editing the agreement automatically re-prompts
 * every client; set it explicitly only to control "material change vs. typo".
 * A configured-but-unreadable `RUNNER_TERMS_FILE` is a hard error rather than a
 * silent "no terms", so a misconfiguration can't quietly drop the gate.
 */
export function loadTermsFromEnv(env: NodeJS.ProcessEnv): RunnerTerms | undefined {
  const body = resolveTermsBody(env);
  if (!body || body.trim() === "") return undefined;
  return {
    version: env.RUNNER_TERMS_VERSION?.trim() || hashTermsVersion(body),
    title: env.RUNNER_TERMS_TITLE?.trim() || "Usage agreement",
    body,
  };
}

function resolveTermsBody(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.RUNNER_TERMS_FILE?.trim();
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      throw new RunnerConfigError(
        `RUNNER_TERMS_FILE could not be read at '${file}': ${(err as Error).message}`,
      );
    }
  }
  return env.RUNNER_TERMS_BODY;
}

/** Short content fingerprint used as the terms version when none is set. Any
 *  edit to the body changes it, which re-prompts every client. */
function hashTermsVersion(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

export function parseCorsOrigins(raw: string | undefined): string[] | "*" {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadCoreConfig(
  env: NodeJS.ProcessEnv,
  defaults: { port?: number } = {},
): RunnerCoreConfig {
  return {
    port: parsePort(env.PORT, defaults.port ?? 8061),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    maxSessions: parsePositiveInt(env.RUNNER_MAX_SESSIONS, 32, "RUNNER_MAX_SESSIONS"),
    // Exited sessions linger so the editor can re-attach and replay their console
    // + inspection history after a page reload. The registry evicts the oldest
    // *terminal* session early when at capacity, so a long TTL never blocks a new
    // run while live sessions are protected.
    exitTtlMs: parsePositiveInt(env.RUNNER_EXIT_TTL_MS, 4 * 60 * 60 * 1000, "RUNNER_EXIT_TTL_MS"),
    replayBufferBytes: parsePositiveInt(
      env.RUNNER_REPLAY_BUFFER_BYTES,
      5_000_000,
      "RUNNER_REPLAY_BUFFER_BYTES",
    ),
    corsOrigins: parseCorsOrigins(env.RUNNER_CORS_ORIGINS),
  };
}
