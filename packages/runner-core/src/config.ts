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
  /** Most RUNNING sessions at once (`RUNNER_MAX_SESSIONS`); suspended ones do
   *  not count. */
  maxSessions: number;
  replayBufferBytes: number;
  corsOrigins: string[] | "*";
  sessions: SessionLifecycleConfig;
  sessionStore: SessionStoreConfig;
  sessionContainers: SessionContainersConfig;
  /** Absent: the runner takes resume secrets only. */
  identity?: IdentityConfig;
}

/**
 * Identity callers (`RUNNER_IDENTITY_AUDIENCE` + `RUNNER_IDENTITY_ISSUERS`):
 * DPoP-bound access tokens from the listed issuers, minted for the audience.
 */
export interface IdentityConfig {
  /** The runner's canonical public https base URL — the RFC 8707 resource, the
   *  expected `aud`, and the base of every DPoP `htu`. */
  audience: string;
  /** Issuer identifiers, each compared to a token's `iss` exactly. */
  issuers: string[];
}

/**
 * Containers a session's workload may start through the engine endpoint the
 * runner serves it (`/v1/sessions/:id/engine/…`). Off by default: it lets a
 * workload start workloads, so an operator opts in and bounds it.
 */
export type SessionContainersConfig =
  | { enabled: false; max: number }
  | {
      enabled: true;
      /** Most containers one session may hold at once (`RUNNER_SESSION_CONTAINERS_MAX`). */
      max: number;
      /** The runner's base URL as a session's workload reaches it
       *  (`RUNNER_INTERNAL_URL`), without a trailing slash. */
      internalUrl: string;
    };

/** How long a session runs, idles and is kept. */
export interface SessionLifecycleConfig {
  /** No SSE/WS subscriber for this long → suspend (`RUNNER_SESSION_IDLE_SECONDS`). */
  idleMs: number;
  /** A running session suspends after this long (`RUNNER_SESSION_MAX_RUNNING_SECONDS`). */
  maxRunningSeconds: number;
  /** A suspended session is deleted with its storage after this long
   *  (`RUNNER_SESSION_RETENTION_SECONDS`). */
  retentionMs: number;
  /** Per-session reloads per minute (`RUNNER_SESSION_RELOAD_LIMIT`). */
  reloadLimitPerMinute: number;
}

/** Where session records live (`RUNNER_SESSION_STORE`). */
export type SessionStoreConfig =
  | {
      kind: "sqlite";
      /** The runner's whole state directory, where `sessions.sqlite` sits:
       *  the host's resolved state root, else `RUNNER_STATE_DIR`; undefined
       *  when neither is given. */
      directory: string | undefined;
    }
  | {
      kind: "postgres";
      /** `RUNNER_SESSION_STORE_URL`. Carries credentials: never log it. */
      url: string;
    };

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
 * An entry of `RUNNER_APPS`, the catalog of co-resident agents a session may
 * run (`features.agents`). The catalog is the whole gate: a client picks an
 * agent by name and can neither pick the image nor read the injected env.
 *
 * The catalog may embed secrets (`env` values), so treat the whole `RUNNER_APPS`
 * value as secret material (docker: a `.env.local` file; k8s: source it from a
 * Secret). Only `name`/`title`/`description` are ever advertised outward —
 * `image` and `env` never leave the runner.
 */
export interface RunnerAppConfig {
  image: string;
  /** Env injected verbatim into the agent container (operator secrets
   *  included), and into nothing else. */
  env?: Record<string, string>;
  /** Workload image pull policy (default `missing`); `always` keeps a moving
   *  tag like `latest-slim` fresh. */
  pullPolicy?: PullPolicy;
  /** The tcp port this image listens on, published by the runner — a client
   *  cannot supply it, because what gets published is the operator's decision.
   *  There is deliberately NO default: the catalog is pure operator
   *  configuration and the runner has no built-in knowledge of any specific
   *  app, so guessing 8080 would be exactly that knowledge. An entry without it
   *  is not offered as an agent. */
  port?: number;
  /** Env var name under which the runner injects a token it mints for every
   *  workload it creates with this agent, reported as `RunnerEndpoint.token` on
   *  the session's `agent` endpoint. A resume or an agent change mints a new
   *  one. A name the entry's own `env` also sets is refused. */
  tokenEnv?: string;
  title?: string;
  description?: string;
}

/** A validated catalog entry with defaults applied, keyed back by its name. */
export interface ResolvedRunnerApp {
  name: string;
  image: string;
  env: Record<string, string>;
  pullPolicy: PullPolicy;
  /** See {@link RunnerAppConfig.port} — undefined when the operator declared
   *  none, which is what makes the entry unusable as an `agent`. */
  port?: number;
  /** See {@link RunnerAppConfig.tokenEnv}. */
  tokenEnv?: string;
  title?: string;
  description?: string;
}

const PULL_POLICIES: readonly string[] = ["missing", "always", "never"];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  if (
    entry.port !== undefined &&
    (typeof entry.port !== "number" || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535)
  ) {
    fail("has an invalid 'port' — expected an integer in 1..65535.");
  }
  if (entry.tokenEnv !== undefined) {
    if (typeof entry.tokenEnv !== "string" || !ENV_NAME.test(entry.tokenEnv)) {
      fail("has an invalid 'tokenEnv' — expected an environment variable name ([A-Za-z_][A-Za-z0-9_]*).");
    }
    // Two sources for one variable would leave which value the workload sees
    // to merge order, and the operator's literal would silently shadow — or be
    // shadowed by — the minted token.
    if (entry.env !== undefined && Object.hasOwn(entry.env as object, entry.tokenEnv as string)) {
      fail(`sets 'tokenEnv' to '${entry.tokenEnv}', which its own 'env' also defines — the runner mints that value per session.`);
    }
  }
  for (const key of ["title", "description"] as const) {
    if (entry[key] !== undefined && typeof entry[key] !== "string") {
      fail(`has an invalid '${key}' — expected a string.`);
    }
  }
  return entry as unknown as RunnerAppConfig;
}

/**
 * Which catalog entries may be a session's co-resident `agent` — the ones that
 * declare a `port`, because the session route refuses the rest and a runner
 * must not advertise what it will reject.
 *
 * Derived here rather than in each runner's capabilities call because this IS
 * the acceptance condition: the two used to be one list by construction
 * (`Object.keys`), and adding a second condition to the route without adding it
 * here is exactly how they drift. An operator upgrading with an existing
 * catalog has no `port` anywhere — the field is new — so an unfiltered
 * advertisement makes the editor attach an agent to every run and every run is
 * refused.
 *
 * Per entry, not per catalog: declaring a port opts an entry into co-resident
 * use.
 */
export function coResidentAgentNames(apps: Record<string, ResolvedRunnerApp>): string[] {
  return Object.keys(apps).filter((name) => apps[name]?.port !== undefined);
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
      port: entry.port,
      tokenEnv: entry.tokenEnv,
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
  defaults: { port?: number; stateDir?: string } = {},
): RunnerCoreConfig {
  refuseRetiredVariables(env);
  return {
    port: parsePort(env.PORT, defaults.port ?? 8061),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    maxSessions: parsePositiveInt(env.RUNNER_MAX_SESSIONS, 8, "RUNNER_MAX_SESSIONS"),
    replayBufferBytes: parsePositiveInt(
      env.RUNNER_REPLAY_BUFFER_BYTES,
      5_000_000,
      "RUNNER_REPLAY_BUFFER_BYTES",
    ),
    corsOrigins: parseCorsOrigins(env.RUNNER_CORS_ORIGINS),
    sessions: loadSessionLifecycleConfig(env),
    sessionStore: loadSessionStoreConfig(env, defaults.stateDir),
    sessionContainers: loadSessionContainersConfig(env),
    ...optionalIdentity(loadIdentityConfig(env)),
  };
}

function optionalIdentity(identity: IdentityConfig | undefined): { identity?: IdentityConfig } {
  return identity ? { identity } : {};
}

/** Variables an earlier runner read, each with what replaced it — a
 *  replacement variable, or null when the setting is gone. */
const RETIRED_VARIABLES: ReadonlyArray<{ name: string; replacement: string | null; why: string }> = [
  { name: "RUNNER_WATCH_SESSIONS", replacement: null, why: "sessions are always on" },
  { name: "RUNNER_WATCH_MAX_SESSIONS", replacement: "RUNNER_MAX_SESSIONS", why: "it bounds running sessions" },
  { name: "RUNNER_WATCH_IDLE_SECONDS", replacement: "RUNNER_SESSION_IDLE_SECONDS", why: "" },
  { name: "RUNNER_WATCH_MAX_TTL_SECONDS", replacement: "RUNNER_SESSION_MAX_RUNNING_SECONDS", why: "" },
  { name: "RUNNER_WATCH_SUSPENDED_TTL_SECONDS", replacement: "RUNNER_SESSION_RETENTION_SECONDS", why: "" },
  { name: "RUNNER_WATCH_RELOAD_LIMIT", replacement: "RUNNER_SESSION_RELOAD_LIMIT", why: "" },
  {
    name: "RUNNER_WORKSPACE_CHECKPOINT_SECONDS",
    replacement: null,
    why: "a session's workspace lives on its own durable storage, so there is no checkpoint",
  },
  { name: "RUNNER_EXIT_TTL_MS", replacement: null, why: "one-shot run sessions are removed" },
  { name: "RUNNER_MAX_TTL_SECONDS", replacement: null, why: "one-shot run sessions are removed" },
  { name: "RUNNER_APP_MAX_TTL_SECONDS", replacement: null, why: "catalog app sessions are removed" },
];

/** Refuses to boot with any retired variable set, naming every one at once. */
export function refuseRetiredVariables(env: NodeJS.ProcessEnv): void {
  const found = RETIRED_VARIABLES.filter(({ name }) => env[name] !== undefined);
  if (found.length === 0) return;
  const lines = found.map(({ name, replacement, why }) =>
    replacement
      ? `  ${name} is renamed: set ${replacement} instead${why ? ` (${why})` : ""}.`
      : `  ${name} is removed: ${why}. Unset it.`,
  );
  throw new RunnerConfigError(
    `this runner no longer reads ${found.length === 1 ? "a variable" : "variables"} its environment sets:\n` +
      lines.join("\n"),
  );
}

export function loadSessionLifecycleConfig(env: NodeJS.ProcessEnv): SessionLifecycleConfig {
  return {
    idleMs:
      parsePositiveInt(env.RUNNER_SESSION_IDLE_SECONDS, 300, "RUNNER_SESSION_IDLE_SECONDS") * 1000,
    maxRunningSeconds: parsePositiveInt(
      env.RUNNER_SESSION_MAX_RUNNING_SECONDS,
      21600,
      "RUNNER_SESSION_MAX_RUNNING_SECONDS",
    ),
    retentionMs:
      parsePositiveInt(
        env.RUNNER_SESSION_RETENTION_SECONDS,
        2_592_000,
        "RUNNER_SESSION_RETENTION_SECONDS",
      ) * 1000,
    reloadLimitPerMinute: parsePositiveInt(
      env.RUNNER_SESSION_RELOAD_LIMIT,
      30,
      "RUNNER_SESSION_RELOAD_LIMIT",
    ),
  };
}

const SESSION_STORES = ["sqlite", "postgres"] as const;

/** `RUNNER_SESSION_STORE` (default `sqlite`). `RUNNER_STATE_DIR` names a
 *  runner's WHOLE state directory, never the store's alone, so a host with a
 *  state root of its own (`stateDir`) has already read it in its own precedence
 *  and its answer is the directory; a container runner has none and reads the
 *  variable here. */
export function loadSessionStoreConfig(
  env: NodeJS.ProcessEnv,
  stateDir?: string,
): SessionStoreConfig {
  const kind = env.RUNNER_SESSION_STORE?.trim() || "sqlite";
  const url = env.RUNNER_SESSION_STORE_URL?.trim() || undefined;
  if (kind === "postgres") {
    if (!url) {
      throw new RunnerConfigError(
        "RUNNER_SESSION_STORE=postgres needs RUNNER_SESSION_STORE_URL: the Postgres connection URL " +
          "the session records are kept at (postgres://user:password@host:5432/database).",
      );
    }
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      // The value carries a password, so it is never quoted back.
      throw new RunnerConfigError(
        "RUNNER_SESSION_STORE_URL is not a URL; expected postgres://user:password@host:5432/database.",
      );
    }
    if (protocol !== "postgres:" && protocol !== "postgresql:") {
      throw new RunnerConfigError(
        `RUNNER_SESSION_STORE_URL must be a postgres:// or postgresql:// URL, got a '${protocol}' one.`,
      );
    }
    return { kind, url };
  }
  if (kind !== "sqlite") {
    throw new RunnerConfigError(
      `RUNNER_SESSION_STORE must be one of ${SESSION_STORES.join(" | ")}, got '${kind}'.`,
    );
  }
  if (url) {
    throw new RunnerConfigError(
      "RUNNER_SESSION_STORE_URL is set, but RUNNER_SESSION_STORE is sqlite — set " +
        "RUNNER_SESSION_STORE=postgres to use it, or unset it.",
    );
  }
  return { kind, directory: stateDir ?? (env.RUNNER_STATE_DIR?.trim() || undefined) };
}

/**
 * A container runner's state directory is the operator's to provide (a PVC, a
 * data volume): it has no root of its own to fall back on, so a SQLite store
 * without `RUNNER_STATE_DIR` is refused at boot.
 */
export function requireStateDirectory(store: SessionStoreConfig): void {
  if (store.kind === "sqlite" && store.directory === undefined) {
    throw new RunnerConfigError(
      "RUNNER_STATE_DIR is required with RUNNER_SESSION_STORE=sqlite (the default): set it to a " +
        "directory on persistent storage, where the runner keeps its session store — or set " +
        "RUNNER_SESSION_STORE=postgres with RUNNER_SESSION_STORE_URL.",
    );
  }
}

export function loadSessionContainersConfig(env: NodeJS.ProcessEnv): SessionContainersConfig {
  const enabled = parseBool(env.RUNNER_SESSION_CONTAINERS, false, "RUNNER_SESSION_CONTAINERS");
  const max = parsePositiveInt(
    env.RUNNER_SESSION_CONTAINERS_MAX,
    4,
    "RUNNER_SESSION_CONTAINERS_MAX",
  );
  if (!enabled) return { enabled, max };
  const raw = env.RUNNER_INTERNAL_URL?.trim();
  if (!raw) {
    throw new RunnerConfigError(
      "RUNNER_SESSION_CONTAINERS is on, so RUNNER_INTERNAL_URL is required: the runner's base URL " +
        "as a session's workload reaches it (e.g. http://runner:8061), where the session's container " +
        "engine is served.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RunnerConfigError(`RUNNER_INTERNAL_URL must be an http(s) URL, got '${raw}'.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RunnerConfigError(`RUNNER_INTERNAL_URL must be an http(s) URL, got '${raw}'.`);
  }
  return { enabled, max, internalUrl: raw.replace(/\/+$/, "") };
}

/** `RUNNER_IDENTITY_AUDIENCE` and `RUNNER_IDENTITY_ISSUERS`, set together or
 *  not at all; undefined when neither is set. */
export function loadIdentityConfig(env: NodeJS.ProcessEnv): IdentityConfig | undefined {
  const rawAudience = env.RUNNER_IDENTITY_AUDIENCE?.trim() || undefined;
  const rawIssuers = env.RUNNER_IDENTITY_ISSUERS?.trim() || undefined;
  if (rawAudience === undefined && rawIssuers === undefined) return undefined;
  if (rawAudience === undefined) {
    throw new RunnerConfigError(
      "RUNNER_IDENTITY_ISSUERS is set without RUNNER_IDENTITY_AUDIENCE: set the audience to the " +
        "runner's public https base URL (e.g. https://runner.example.com), or unset the issuers to " +
        "take resume secrets only.",
    );
  }
  if (rawIssuers === undefined) {
    throw new RunnerConfigError(
      "RUNNER_IDENTITY_AUDIENCE is set without RUNNER_IDENTITY_ISSUERS: list the https issuer " +
        "identifiers whose access tokens this runner accepts, comma-separated, or unset the audience " +
        "to take resume secrets only.",
    );
  }
  const issuers = [
    ...new Set(
      rawIssuers
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];
  if (issuers.length === 0) {
    throw new RunnerConfigError(
      "RUNNER_IDENTITY_ISSUERS lists no issuer: give comma-separated https issuer identifiers.",
    );
  }
  for (const issuer of issuers) parseHttpsUrl(issuer, "RUNNER_IDENTITY_ISSUERS", "an issuer");
  return { audience: parseAudience(rawAudience), issuers };
}

function parseAudience(raw: string): string {
  const url = parseHttpsUrl(raw, "RUNNER_IDENTITY_AUDIENCE", "the audience");
  const canonical = url.origin + (url.pathname === "/" ? "" : url.pathname);
  if (raw.endsWith("/")) {
    throw new RunnerConfigError(
      `RUNNER_IDENTITY_AUDIENCE must not end with a slash: write '${canonical.replace(/\/+$/, "")}'.`,
    );
  }
  if (canonical !== raw) {
    throw new RunnerConfigError(
      `RUNNER_IDENTITY_AUDIENCE must be written canonically, as clients compare it exactly: ` +
        `write '${canonical}' instead of '${raw}'.`,
    );
  }
  return raw;
}

function parseHttpsUrl(raw: string, variable: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RunnerConfigError(`${variable}: ${what} '${raw}' is not a URL; expected https://host[/path].`);
  }
  if (url.protocol !== "https:") {
    throw new RunnerConfigError(
      `${variable}: ${what} '${raw}' must be an https URL — an identity is only accepted over TLS.`,
    );
  }
  if (raw.includes("?") || raw.includes("#")) {
    throw new RunnerConfigError(`${variable}: ${what} '${raw}' must carry no query and no fragment.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new RunnerConfigError(`${variable}: ${what} '${raw}' must carry no user or password.`);
  }
  return url;
}
