export interface RunnerConfig {
  port: number;
  bundleRoot: string;
  bundleVolume: string;
  childNetwork: string;
  logLevel: string;
  maxSessions: number;
  exitTtlMs: number;
  replayBufferBytes: number;
  corsOrigins: string[] | "*";
}

export class RunnerConfigError extends Error {}

function parsePositiveInt(raw: string | undefined, fallback: number, field: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new RunnerConfigError(`${field} must be a positive integer, got '${raw}'.`);
  }
  return n;
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

  const portStr = env.PORT ?? "8061";
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RunnerConfigError(`PORT must be an integer in 1..65535, got '${portStr}'.`);
  }

  return {
    port,
    bundleRoot: env.BUNDLE_ROOT?.trim() || "/bundles",
    bundleVolume,
    childNetwork,
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

function parseCorsOrigins(raw: string | undefined): string[] | "*" {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
