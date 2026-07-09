import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PullPolicy, RunnerTerms } from "./contract.js";

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

export function parseBool(raw: string | undefined, fallback: boolean, field: string): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new RunnerConfigError(`${field} must be a boolean (true/false), got '${raw}'.`);
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

/**
 * An operator-predefined application entry in `RUNNER_APPS`. The catalog is the
 * whole gate: a client launches an app by name and can neither pick the image
 * nor read the injected env, so no allowlist beyond the catalog is needed.
 *
 * The catalog may embed secrets (`env` values), so treat the whole `RUNNER_APPS`
 * value as secret material (docker: a `.env.local` file; k8s: source it from a
 * Secret). Only `name`/`title`/`description` are ever advertised outward —
 * `image` and `env` never leave the runner.
 */
export interface RunnerAppConfig {
  image: string;
  /** Env injected verbatim into the app's workload (operator secrets included).
   *  A client-supplied value for any key defined here is dropped — operator
   *  values always win. */
  env?: Record<string, string>;
  /** Workload image pull policy (default `missing`); `always` keeps a moving
   *  tag like `latest-slim` fresh. */
  pullPolicy?: PullPolicy;
  title?: string;
  description?: string;
}

/** A validated catalog entry with defaults applied, keyed back by its name. */
export interface ResolvedRunnerApp {
  name: string;
  image: string;
  env: Record<string, string>;
  pullPolicy: PullPolicy;
  title?: string;
  description?: string;
}

const PULL_POLICIES: readonly string[] = ["missing", "always", "never"];

/**
 * Parse the `RUNNER_APPS` JSON catalog ({ "<name>": RunnerAppConfig }).
 * Returns `undefined` when unset (no apps offered). Malformed JSON or entries
 * are a hard `RunnerConfigError` — a broken catalog must not silently drop
 * the apps.
 */
export function loadAppsFromEnv(
  env: NodeJS.ProcessEnv,
): Record<string, RunnerAppConfig> | undefined {
  const raw = env.RUNNER_APPS?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RunnerConfigError(`RUNNER_APPS is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RunnerConfigError("RUNNER_APPS must be a JSON object mapping app name → app config.");
  }
  // Null-prototype map so an app literally named `__proto__` is stored as a
  // plain key rather than mutating the object's prototype.
  const catalog: Record<string, RunnerAppConfig> = Object.create(null);
  for (const [name, value] of Object.entries(parsed)) {
    catalog[name] = validateAppEntry(name, value);
  }
  return catalog;
}

function validateAppEntry(name: string, value: unknown): RunnerAppConfig {
  const fail = (detail: string): never => {
    throw new RunnerConfigError(`RUNNER_APPS entry '${name}' ${detail}`);
  };
  if (name.trim() === "") fail("has an empty name.");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("must be an object.");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.image !== "string" || entry.image.trim() === "") {
    fail("needs a non-empty string 'image'.");
  }
  if (
    entry.env !== undefined &&
    (entry.env === null ||
      typeof entry.env !== "object" ||
      Array.isArray(entry.env) ||
      Object.values(entry.env).some((v) => typeof v !== "string"))
  ) {
    fail("has an invalid 'env' — expected an object of string values.");
  }
  if (entry.pullPolicy !== undefined && !PULL_POLICIES.includes(entry.pullPolicy as string)) {
    fail(`has an invalid 'pullPolicy' — expected one of ${PULL_POLICIES.join(", ")}.`);
  }
  for (const key of ["title", "description"] as const) {
    if (entry[key] !== undefined && typeof entry[key] !== "string") {
      fail(`has an invalid '${key}' — expected a string.`);
    }
  }
  return entry as unknown as RunnerAppConfig;
}

/** The catalog runners pass to `buildServer`: `RUNNER_APPS` validated with
 *  defaults applied; empty when unset. The catalog is pure operator
 *  configuration — runner-core knows nothing about any specific app. */
export function loadResolvedApps(env: NodeJS.ProcessEnv): Record<string, ResolvedRunnerApp> {
  const catalog = loadAppsFromEnv(env) ?? {};
  const resolved: Record<string, ResolvedRunnerApp> = Object.create(null);
  for (const [name, entry] of Object.entries(catalog)) {
    resolved[name] = {
      name,
      image: entry.image,
      env: entry.env ?? {},
      pullPolicy: entry.pullPolicy ?? "missing",
      title: entry.title,
      description: entry.description,
    };
  }
  return resolved;
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
