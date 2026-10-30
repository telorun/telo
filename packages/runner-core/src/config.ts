import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

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

/** The name the co-resident agent is offered and addressed by: `features.agents`,
 *  a session's `agent` field and the `agent` endpoint. */
export const AGENT_NAME = "authoring-agent";

/**
 * Where a co-resident agent runs from: a container image, or a telo module the
 * runner's own kernel image runs (`telo run <ref>`, fetched at start). A `ref`
 * is an `oci://` reference or an absolute path on the host.
 */
export type AgentSource = { kind: "image"; image: string } | { kind: "module"; ref: string };

/**
 * The co-resident agent a session may run, configured by the operator's
 * `AGENT_*` variables (`loadAgentFromEnv`) or a configuration file
 * (`loadAgentFromObject`). The client picks it by name and can neither pick its
 * source nor read its env.
 *
 * `env` may embed secrets, so treat `AGENT_ENV` as secret material (docker: a
 * `.env.local` file); a file names its secrets only, each read from an
 * `AGENT_SECRET_<NAME>` variable. Only `name`, `title` and `description` are
 * advertised outward.
 */
export interface RunnerAgent {
  name: string;
  source: AgentSource;
  /** Env injected verbatim into the agent and into nothing else. */
  env: Record<string, string>;
  /** Image pull policy (default `missing`); an image source only. */
  pullPolicy: PullPolicy;
  /** The tcp port the agent listens on, published by the runner. Required: the
   *  runner knows nothing about any specific agent, so it cannot guess one. */
  port: number;
  /** Env var name under which the runner injects a token it mints for every
   *  workload it creates with this agent, reported as `RunnerEndpoint.token` on
   *  the session's `agent` endpoint. A name the `env` also sets is refused. */
  tokenEnv?: string;
  title?: string;
  description?: string;
}

/** The image an agent's container runs on: its own, or the operator's kernel
 *  image, which runs the module (`telo run <ref>`). */
export function agentImage(agent: RunnerAgent, kernelImage: string): string {
  return agent.source.kind === "image" ? agent.source.image : kernelImage;
}

const PULL_POLICIES: readonly string[] = ["missing", "always", "never"];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The variables that configure the co-resident agent; `AGENT_ENV` may hold
 *  secrets, so a runner keeps all of them out of what its workloads inherit. */
export const AGENT_VARIABLES = [
  "AGENT_IMAGE",
  "AGENT_MODULE_REF",
  "AGENT_PORT",
  "AGENT_PULL_POLICY",
  "AGENT_TOKEN_ENV",
  "AGENT_TITLE",
  "AGENT_DESCRIPTION",
  "AGENT_ENV",
] as const;

/** A setting of the co-resident agent, as `resolveAgent` reads it. */
type AgentSetting = "image" | "moduleRef" | "port" | "pullPolicy" | "tokenEnv" | "title" | "description";

const AGENT_SETTING_VARIABLES: Record<AgentSetting, (typeof AGENT_VARIABLES)[number]> = {
  image: "AGENT_IMAGE",
  moduleRef: "AGENT_MODULE_REF",
  port: "AGENT_PORT",
  pullPolicy: "AGENT_PULL_POLICY",
  tokenEnv: "AGENT_TOKEN_ENV",
  title: "AGENT_TITLE",
  description: "AGENT_DESCRIPTION",
};

/** The agent's settings, whichever source they were read from; `env` lists
 *  each source of its environment under the name a refusal gives it. */
interface AgentSettings {
  values: Partial<Record<AgentSetting, string | number>>;
  env: ReadonlyArray<{ name: string; values: () => Record<string, string> }>;
  /** What a refusal calls a setting: a variable, or a key of a file. */
  nameOf: (setting: AgentSetting) => string;
  /** Every setting given, named as `nameOf` names it — what an agent with no
   *  source is refused for. */
  given: string[];
}

/**
 * The co-resident agent from the `AGENT_*` variables, or `undefined` when none
 * is configured. Exactly one of `AGENT_IMAGE` and `AGENT_MODULE_REF` names what
 * runs; a malformed setting is a hard `RunnerConfigError`, so a broken agent
 * never silently disappears from `features.agents`.
 */
export function loadAgentFromEnv(env: NodeJS.ProcessEnv): RunnerAgent | undefined {
  const get = (name: string): string | undefined => env[name]?.trim() || undefined;
  const values: AgentSettings["values"] = {};
  for (const [setting, variable] of Object.entries(AGENT_SETTING_VARIABLES)) {
    const value = get(variable);
    if (value !== undefined) values[setting as AgentSetting] = value;
  }
  return resolveAgent({
    values,
    env: [{ name: "AGENT_ENV", values: () => parseAgentEnv(get("AGENT_ENV")) }],
    nameOf: (setting) => AGENT_SETTING_VARIABLES[setting],
    given: AGENT_VARIABLES.filter((name) => get(name) !== undefined),
  });
}

const AGENT_FILE_KEYS = [...Object.keys(AGENT_SETTING_VARIABLES), "env", "secretEnv"];

/**
 * The co-resident agent from an already-parsed configuration file: the keys
 * `image` | `moduleRef`, `port`, `pullPolicy`, `tokenEnv`, `title`,
 * `description`, `env` (a map of strings) and `secretEnv` (a list of names,
 * each read from the `AGENT_SECRET_<NAME>` variable of `env`, so a secret never
 * sits in the file). Validated exactly as `loadAgentFromEnv`, refusals naming
 * the file's keys; an unknown key, or a secret whose variable is unset, is a
 * hard `RunnerConfigError`. An empty string is an absent setting.
 */
export function loadAgentFromObject(
  value: unknown,
  options: { file: string; env: NodeJS.ProcessEnv },
): RunnerAgent | undefined {
  const { file, env } = options;
  const nameOf = (key: string): string => `\`${key}\` in ${file}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunnerConfigError(`${file} must hold a map of the agent's settings.`);
  }
  const values: AgentSettings["values"] = {};
  const given: string[] = [];
  let plainEnv: Record<string, string> = {};
  let secretEnv: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!AGENT_FILE_KEYS.includes(key)) {
      throw new RunnerConfigError(
        `${nameOf(key)} is not an agent setting (expected one of: ${AGENT_FILE_KEYS.join(", ")}).`,
      );
    }
    const setting = typeof raw === "string" ? raw.trim() : raw;
    if (setting === null || setting === "") continue;
    given.push(nameOf(key));
    if (key === "env") plainEnv = stringMap(setting, nameOf(key));
    else if (key === "secretEnv") secretEnv = secretValues(setting, nameOf(key), env);
    else if (typeof setting === "string" || (key === "port" && typeof setting === "number")) {
      values[key as AgentSetting] = setting;
    } else {
      throw new RunnerConfigError(
        `${nameOf(key)} must be ${key === "port" ? "an integer in 1..65535" : "a string"}.`,
      );
    }
  }
  return resolveAgent({
    values,
    env: [
      { name: nameOf("env"), values: () => plainEnv },
      { name: nameOf("secretEnv"), values: () => secretEnv },
    ],
    nameOf,
    given,
  });
}

function stringMap(raw: unknown, name: string): Record<string, string> {
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.values(raw as object).some((v) => typeof v !== "string")
  ) {
    throw new RunnerConfigError(`${name} must be a map of string values.`);
  }
  return raw as Record<string, string>;
}

/** Each named secret's value, from its `AGENT_SECRET_<NAME>` variable. */
function secretValues(raw: unknown, name: string, env: NodeJS.ProcessEnv): Record<string, string> {
  if (!Array.isArray(raw) || raw.some((key) => typeof key !== "string" || !ENV_NAME.test(key))) {
    throw new RunnerConfigError(
      `${name} must be a list of environment variable names ([A-Za-z_][A-Za-z0-9_]*).`,
    );
  }
  const secrets: Record<string, string> = {};
  for (const key of raw as string[]) {
    const variable = `AGENT_SECRET_${key}`;
    const secret = env[variable];
    if (secret === undefined) {
      throw new RunnerConfigError(
        `${name} lists '${key}', but ${variable} is unset: the runner reads the secret's value from it.`,
      );
    }
    secrets[key] = secret;
  }
  return secrets;
}

function resolveAgent(settings: AgentSettings): RunnerAgent | undefined {
  const { values, nameOf } = settings;
  const text = (setting: AgentSetting): string | undefined =>
    values[setting] === undefined ? undefined : String(values[setting]);
  const image = text("image");
  const ref = text("moduleRef");
  const sources = `${nameOf("image")} or ${nameOf("moduleRef")}`;
  if (image === undefined && ref === undefined) {
    const stray = settings.given;
    if (stray.length > 0) {
      throw new RunnerConfigError(
        `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} set, but the agent is configured by ` +
          `${sources} — set one of them, or unset ${stray.length === 1 ? "it" : "them"}.`,
      );
    }
    return undefined;
  }
  if (image !== undefined && ref !== undefined) {
    throw new RunnerConfigError(`${nameOf("image")} and ${nameOf("moduleRef")} are both set — set one of them.`);
  }

  const port = text("port");
  if (port === undefined) {
    throw new RunnerConfigError(
      `${nameOf("port")} is required: set it to the tcp port the agent listens on.`,
    );
  }
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new RunnerConfigError(`${nameOf("port")} must be an integer in 1..65535, got '${port}'.`);
  }

  const pullPolicy = text("pullPolicy") ?? "missing";
  if (!PULL_POLICIES.includes(pullPolicy)) {
    throw new RunnerConfigError(
      `${nameOf("pullPolicy")} must be one of ${PULL_POLICIES.join(", ")}, got '${pullPolicy}'.`,
    );
  }

  const tokenEnv = text("tokenEnv");
  if (tokenEnv !== undefined && !ENV_NAME.test(tokenEnv)) {
    throw new RunnerConfigError(
      `${nameOf("tokenEnv")} must be an environment variable name ([A-Za-z_][A-Za-z0-9_]*), got '${tokenEnv}'.`,
    );
  }

  const agentEnv: Record<string, string> = {};
  const definedBy = new Map<string, string>();
  for (const source of settings.env) {
    for (const [key, value] of Object.entries(source.values())) {
      const earlier = definedBy.get(key);
      if (earlier !== undefined) {
        throw new RunnerConfigError(`'${key}' is defined by both ${earlier} and ${source.name} — define it once.`);
      }
      definedBy.set(key, source.name);
      agentEnv[key] = value;
    }
  }
  // Two sources for one variable would leave which value the agent sees to
  // merge order; the runner mints the token, so the operator's literal loses.
  if (tokenEnv !== undefined && definedBy.has(tokenEnv)) {
    throw new RunnerConfigError(
      `${nameOf("tokenEnv")} is '${tokenEnv}', which ${definedBy.get(tokenEnv)} also defines — ` +
        "the runner mints that value per session.",
    );
  }

  let source: AgentSource;
  if (image !== undefined) {
    source = { kind: "image", image };
  } else {
    if (!ref!.startsWith("oci://") && !isAbsolute(ref!)) {
      throw new RunnerConfigError(
        `${nameOf("moduleRef")} must be an oci:// reference or an absolute host path, got '${ref}'.`,
      );
    }
    source = { kind: "module", ref: ref! };
  }

  const title = text("title");
  const description = text("description");
  return {
    name: AGENT_NAME,
    source,
    env: agentEnv,
    pullPolicy: pullPolicy as PullPolicy,
    port: portNumber,
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/** `AGENT_ENV`: a JSON object of string values, the agent's plain env. */
function parseAgentEnv(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RunnerConfigError(`AGENT_ENV is not valid JSON: ${(err as Error).message}`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== "string")
  ) {
    throw new RunnerConfigError("AGENT_ENV must be a JSON object of string values.");
  }
  return parsed as Record<string, string>;
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
  {
    name: "RUNNER_APPS",
    replacement: "AGENT_IMAGE or AGENT_MODULE_REF",
    why: "the catalog is one co-resident agent, configured by AGENT_* variables",
  },
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
  return sessionContainersConfig(
    {
      enabled: parseBool(env.RUNNER_SESSION_CONTAINERS, false, "RUNNER_SESSION_CONTAINERS"),
      max: parsePositiveInt(env.RUNNER_SESSION_CONTAINERS_MAX, 4, "RUNNER_SESSION_CONTAINERS_MAX"),
    },
    env,
    "RUNNER_SESSION_CONTAINERS",
  );
}

/**
 * Session containers from settings a runner read itself (`enabledBy` names
 * the setting that turned them on, for the refusal), completed with the
 * `RUNNER_INTERNAL_URL` they need.
 */
export function sessionContainersConfig(
  settings: { enabled: boolean; max: number },
  env: NodeJS.ProcessEnv,
  enabledBy: string,
): SessionContainersConfig {
  const { enabled, max } = settings;
  if (!enabled) return { enabled, max };
  const raw = env.RUNNER_INTERNAL_URL?.trim();
  if (!raw) {
    throw new RunnerConfigError(
      `${enabledBy} is on, so RUNNER_INTERNAL_URL is required: the runner's base URL ` +
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
