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
    maxSessions: parsePositiveInt(env.RUNNER_MAX_SESSIONS, 8, "RUNNER_MAX_SESSIONS"),
    exitTtlMs: parsePositiveInt(env.RUNNER_EXIT_TTL_MS, 5 * 60 * 1000, "RUNNER_EXIT_TTL_MS"),
    replayBufferBytes: parsePositiveInt(
      env.RUNNER_REPLAY_BUFFER_BYTES,
      5_000_000,
      "RUNNER_REPLAY_BUFFER_BYTES",
    ),
    corsOrigins: parseCorsOrigins(env.RUNNER_CORS_ORIGINS),
  };
}
