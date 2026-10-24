import type { JSONSchema7 } from "json-schema";

import { challengeParam } from "../../identity-credentials";
import type { RunnerCredentials } from "../../runner-credentials";
import {
  RunnerRefusal,
  SessionGoneError,
  TeloVersionRefusedError,
  TermsRequiredError,
  type AdoptedSession,
  type AvailabilityReport,
  type ConfigIssue,
  type CreatedSession,
  type ListedSession,
  type RunAdapter,
  type RunnerCapabilities,
  type RunnerConnection,
  type RunnerEndpoint,
  type RunnerSession,
  type RunnerTerms,
  type RunStatus,
  type SessionDocument,
  type WorkspaceChangeSet,
  type WorkspaceFileEntry,
} from "../../types";
import { makeHttpRunnerIo } from "./io-client";
import { openSessionEvents } from "./sse-client";

const HEALTH_TIMEOUT_MS = 2_000;
/** Workspace writes and reloads travel to the container and back, so they get a
 *  budget of their own rather than the health probe's. */
const WORKSPACE_TIMEOUT_MS = 30_000;

/** Wire header carrying the accepted terms version (mirrors runner-core's
 *  `ACCEPTED_TERMS_HEADER`). Kept as a local constant so editor code doesn't
 *  depend on the Node-only `@telorun/runner-core` package. */
const ACCEPTED_TERMS_HEADER = "x-telo-accepted-terms";

interface ErrorResponse {
  error: string;
  message?: string;
  stage?: string;
  daemonMessage?: string;
  /** Why a `telo_version_*` refusal was made, in the runner's words, and the
   *  app and version it was made for. */
  reason?: string;
  app?: unknown;
  version?: unknown;
  /** The current terms, on a `428 terms_required`. */
  terms?: RunnerTerms;
  [key: string]: unknown;
}

function withoutProperties(
  config: Record<string, unknown>,
  withheld: string[] | undefined,
): Record<string, unknown> {
  if (!withheld || withheld.length === 0) return config;
  return Object.fromEntries(Object.entries(config).filter(([key]) => !withheld.includes(key)));
}

/**
 * Every runner adapter speaks the identical `/v1` HTTP+SSE contract — they
 * differ only in their config shape and the `config` payload they send. This
 * factory owns the shared wire logic (health/probe, the session routes, the
 * event stream and the byte channel, every request authorized through the
 * session's credentials) so the adapters can't drift, mirroring the
 * server-side runner-core extraction.
 */
export interface HttpRunnerAdapterOptions<Config extends { baseUrl: string }> {
  id: string;
  displayName: string;
  description: string;
  configSchema: JSONSchema7;
  defaultConfig: Config;
  /** Adapter-specific validation beyond the always-checked baseUrl. */
  validateExtra?: (config: Config) => ConfigIssue[];
  /** The `config` object sent in /v1/probe and /v1/sessions bodies. */
  buildRequestConfig: (config: Config) => Record<string, unknown>;
  startTimeoutMs: number;
}

export function createHttpRunnerAdapter<Config extends { baseUrl: string }>(
  opts: HttpRunnerAdapterOptions<Config>,
): RunAdapter<Config> {
  return {
    id: opts.id,
    displayName: opts.displayName,
    description: opts.description,
    configSchema: opts.configSchema,
    defaultConfig: opts.defaultConfig,

    validateConfig(config) {
      const issues: ConfigIssue[] = [];
      const baseUrlIssue = validateBaseUrl(config.baseUrl);
      if (baseUrlIssue) issues.push(baseUrlIssue);
      if (opts.validateExtra) issues.push(...opts.validateExtra(config));
      return issues;
    },

    async resolveBaseUrl(config) {
      return validateBaseUrl(config.baseUrl) ? null : config.baseUrl;
    },

    async fetchCapabilities(config): Promise<RunnerCapabilities | null> {
      if (validateBaseUrl(config.baseUrl)) return null;
      const base = trimTrailingSlash(config.baseUrl);
      let res: Response;
      try {
        res = await fetchWithTimeout(`${base}/v1/capabilities`, { method: "GET" }, HEALTH_TIMEOUT_MS);
      } catch {
        // Unreachable — distinct from a present-but-endpoint-less runner.
        throw new Error(`Couldn't reach the runner at ${config.baseUrl}.`);
      }
      // 404 = endpoint legitimately absent (older runner) → fall back quietly.
      if (res.status === 404) return null;
      // Any other non-OK is a real misconfiguration, not graceful absence.
      if (!res.ok) {
        throw new Error(`Runner returned HTTP ${res.status} on /v1/capabilities.`);
      }
      try {
        return (await res.json()) as RunnerCapabilities;
      } catch {
        throw new Error("Runner returned a malformed /v1/capabilities document.");
      }
    },

    async isAvailable(config): Promise<AvailabilityReport> {
      const base = trimTrailingSlash(config.baseUrl);

      let healthRes: Response;
      try {
        healthRes = await fetchWithTimeout(`${base}/v1/health`, { method: "GET" }, HEALTH_TIMEOUT_MS);
      } catch {
        return {
          status: "unavailable",
          message: `Runner unreachable at ${config.baseUrl}.`,
          remediation: "Start the runner service or fix the URL.",
        };
      }
      if (!healthRes.ok) {
        return { status: "unavailable", message: `Runner returned HTTP ${healthRes.status} on /v1/health.` };
      }

      let probeRes: Response;
      try {
        probeRes = await fetchWithTimeout(
          `${base}/v1/probe`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ config: opts.buildRequestConfig(config) }),
          },
          HEALTH_TIMEOUT_MS * 3,
        );
      } catch {
        return { status: "unavailable", message: `Runner probe call failed at ${config.baseUrl}.` };
      }
      if (!probeRes.ok) {
        return { status: "unavailable", message: `Runner returned HTTP ${probeRes.status} on /v1/probe.` };
      }
      const report = (await probeRes.json()) as AvailabilityReport;
      // `action` is a local behavior object (a callable), never a wire field —
      // drop anything a remote runner put there so the banner can't render a
      // button whose `run` isn't a function.
      if (report && typeof report === "object") delete (report as { action?: unknown }).action;
      return report;
    },

    async connect(config): Promise<RunnerConnection> {
      const issue = validateBaseUrl(config.baseUrl);
      if (issue) throw new Error(issue.message);
      return createConnection(trimTrailingSlash(config.baseUrl), opts.buildRequestConfig(config), opts.startTimeoutMs);
    },
  };
}

function createConnection(
  base: string,
  requestConfig: Record<string, unknown>,
  startTimeoutMs: number,
): RunnerConnection {
  return {
    baseUrl: base,
    async createSession(request, { acceptedTermsVersion, withheldConfig, credentials }): Promise<CreatedSession> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (acceptedTermsVersion) headers[ACCEPTED_TERMS_HEADER] = acceptedTermsVersion;
      const res = await authorizedFetch(
        base,
        credentials,
        "POST",
        "/v1/sessions",
        {
          headers,
          body: JSON.stringify({
            workspace: request.workspace,
            apps: request.apps,
            config: withoutProperties(requestConfig, withheldConfig),
            ...(request.agent ? { agent: request.agent } : {}),
          }),
        },
        startTimeoutMs,
        "create the session",
      );
      if (res.status === 201) {
        const body = (await res.json()) as { sessionId: string; resumeSecret?: string };
        return {
          kind: "created",
          sessionId: body.sessionId,
          ...(body.resumeSecret ? { resumeSecret: body.resumeSecret } : {}),
        };
      }
      const refusal = await refusalOf(res, "create the session");
      if (refusal instanceof RunnerRefusal && refusal.code === "session_exists") {
        const existing = refusal.body.sessionId;
        if (typeof existing === "string") return { kind: "exists", sessionId: existing };
      }
      throw refusal;
    },

    async listSessions(workspace, credentials): Promise<ListedSession[]> {
      const res = await authorizedFetch(
        base,
        credentials,
        "GET",
        "/v1/sessions",
        { query: `workspace=${encodeURIComponent(workspace)}` },
        WORKSPACE_TIMEOUT_MS,
        "list your sessions",
      );
      if (!res.ok) throw await refusalOf(res, "list your sessions");
      const body = (await res.json()) as { sessions?: unknown };
      if (!Array.isArray(body.sessions)) throw new Error("The runner listed no sessions array.");
      return body.sessions.filter(
        (s): s is ListedSession =>
          typeof s === "object" && s !== null && typeof (s as ListedSession).sessionId === "string",
      );
    },

    async adoptSession(sessionId, resumeSecret, credentials): Promise<AdoptedSession> {
      const res = await authorizedFetch(
        base,
        credentials,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionId)}/owner`,
        { headers: { "content-type": "application/json" }, body: JSON.stringify({ resumeSecret }) },
        WORKSPACE_TIMEOUT_MS,
        "adopt the session",
      );
      if (res.ok) {
        const body = (await res.json()) as { sessionId?: unknown };
        return { kind: "adopted", sessionId: typeof body.sessionId === "string" ? body.sessionId : sessionId };
      }
      const refusal = await refusalOf(res, "adopt the session", { sessionRoute: true });
      if (refusal instanceof SessionGoneError) return { kind: "gone" };
      if (refusal instanceof RunnerRefusal && refusal.code === "session_exists") {
        const existing = refusal.body.sessionId;
        if (typeof existing === "string") return { kind: "exists", sessionId: existing };
      }
      throw refusal;
    },

    session(sessionId, credentials): RunnerSession {
      return createSession(base, sessionId, credentials, startTimeoutMs);
    },
  };
}

function createSession(
  base: string,
  sessionId: string,
  credentials: RunnerCredentials,
  startTimeoutMs: number,
): RunnerSession {
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}`;
  // Where this session's event stream got to, across the streams opened on it.
  const cursor = { value: 0 };
  const call = async (
    method: string,
    route: string,
    what: string,
    init: { body?: unknown; query?: string; timeoutMs?: number } = {},
  ): Promise<Response> => {
    const res = await authorizedFetch(
      base,
      credentials,
      method,
      `${path}${route}`,
      {
        ...(init.query ? { query: init.query } : {}),
        ...(init.body !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }
          : {}),
      },
      init.timeoutMs ?? WORKSPACE_TIMEOUT_MS,
      what,
    );
    if (!res.ok) throw await refusalOf(res, what, { sessionRoute: true });
    return res;
  };

  return {
    id: sessionId,

    async read(): Promise<SessionDocument> {
      const res = await call("GET", "", "read the session");
      const doc = (await res.json()) as SessionDocument;
      return { ...doc, status: fillEndpointHost(doc.status, base) };
    },
    async resume() {
      await call("POST", "/resume", "resume the session", { timeoutMs: startTimeoutMs });
    },
    async suspend() {
      await call("POST", "/suspend", "suspend the session");
    },
    async setApps(apps) {
      await call("PUT", "/apps", "change the session's applications", {
        body: { apps },
        timeoutMs: startTimeoutMs,
      });
    },
    async setAgent(name) {
      await call("PUT", "/agent", "change the session's agent", { body: { name }, timeoutMs: startTimeoutMs });
    },
    async runApp(app, request) {
      const res = await call("POST", `/apps/${encodeURIComponent(app)}/run`, `run '${app}'`, {
        body: request,
        timeoutMs: startTimeoutMs,
      });
      const { runId } = (await res.json()) as { runId: string };
      return runId;
    },
    async stopApp(app) {
      await call("POST", `/apps/${encodeURIComponent(app)}/stop`, `stop '${app}'`);
    },
    async reload(app) {
      await call("POST", "/reload", `reload '${app}'`, { query: `app=${encodeURIComponent(app)}` });
    },
    async workspaceTree(): Promise<WorkspaceFileEntry[]> {
      const res = await call("GET", "/workspace", "read the workspace");
      const body = (await res.json()) as { files?: WorkspaceFileEntry[] };
      // No list is not an empty workspace: read as one, the sync would delete
      // the editor's files.
      if (!Array.isArray(body.files)) {
        throw new Error("Couldn't read the workspace — runner returned no file list.");
      }
      return body.files;
    },
    async readWorkspaceFile(file: string): Promise<string> {
      const res = await call("GET", "/workspace/file", `read '${file}'`, {
        query: `path=${encodeURIComponent(file)}`,
      });
      const body = (await res.json()) as { content?: unknown };
      return typeof body.content === "string" ? body.content : "";
    },
    async applyWorkspace(changes: WorkspaceChangeSet) {
      await call("POST", "/workspace", "sync the workspace", { body: changes });
    },
    subscribe(onEvent, onClosed) {
      const stream = openSessionEvents({
        url: `${base}${path}/events`,
        credentials,
        cursor,
        onEvent: (event) =>
          onEvent(event.type === "status" ? { ...event, status: fillEndpointHost(event.status, base) } : event),
        onClosed,
      });
      return () => stream.close();
    },
    io(app, fromSeq) {
      return makeHttpRunnerIo({
        url: `${base.replace(/^http(s?):/i, "ws$1:")}${path}/io`,
        fromSeq,
        async ticket() {
          const res = await call("POST", "/io-tickets", `open '${app}'s terminal`, { body: { app } });
          const { ticket } = (await res.json()) as { ticket: string };
          return ticket;
        },
      });
    },
  };
}

/**
 * The error a refused request stands for, in the runner's words. On a session
 * route a `404 not_found` is the session gone for these credentials, which the
 * caller answers by creating a new one.
 */
async function refusalOf(
  res: Response,
  what: string,
  options: { sessionRoute?: boolean } = {},
): Promise<Error> {
  let body: ErrorResponse | null = null;
  try {
    body = (await res.json()) as ErrorResponse;
  } catch {
    // fall through to the status code
  }
  if (res.status === 428 && body?.terms) return new TermsRequiredError(body.terms);
  if (options.sessionRoute && res.status === 404 && body?.error === "not_found") return new SessionGoneError();
  const challenge = res.headers.get("www-authenticate");
  const code = body?.error ?? (challenge ? challengeParam(challenge, "error") : null) ?? `http_${res.status}`;
  const said = body?.daemonMessage ?? body?.message ?? (challenge ? challengeParam(challenge, "error_description") : null);
  if (code === "identity_provider_unavailable") {
    return new RunnerRefusal(
      res.status,
      code,
      `The runner cannot reach the identity provider to check your sign-in${said ? `: ${said}` : ""}. Try again.`,
      { ...(body ?? {}) },
    );
  }
  if (code === "invalid_token" || code === "invalid_dpop_proof") {
    return new RunnerRefusal(
      res.status,
      code,
      `The runner refused your sign-in (${code})${said ? `: ${said}` : "."}`,
      { ...(body ?? {}) },
    );
  }
  const message = said ?? `Couldn't ${what} — runner returned HTTP ${res.status}.`;
  if (body?.error === "telo_version_unavailable" || body?.error === "telo_version_unsupported") {
    return new TeloVersionRefusedError(
      body.error,
      typeof body.version === "string" ? body.version : undefined,
      body.reason ?? message,
      typeof body.app === "string" ? body.app : undefined,
    );
  }
  return new RunnerRefusal(res.status, code, message, { ...(body ?? {}) });
}

export function validateBaseUrl(raw: string): ConfigIssue | null {
  if (!raw || raw.trim() === "") return { path: "/baseUrl", message: "Runner URL is required." };
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { path: "/baseUrl", message: "Runner URL must use http:// or https://." };
    }
    return null;
  } catch {
    return { path: "/baseUrl", message: "Runner URL is not a valid URL." };
  }
}

/**
 * One request authorized by `credentials` (none: unauthenticated). Headers are
 * asked per attempt, and a refusal the credentials can repair — an expired
 * token — is tried once more with new ones. A credential that cannot be had
 * fails in its own words; only a request that never got an answer is
 * "couldn't reach".
 */
async function authorizedFetch(
  base: string,
  credentials: RunnerCredentials | undefined,
  method: string,
  route: string,
  init: { headers?: Record<string, string>; body?: string; query?: string },
  timeoutMs: number,
  what: string,
): Promise<Response> {
  const url = base + route;
  const attempt = async (): Promise<Response> => {
    const authorization = credentials ? await credentials.headers({ method, url }) : {};
    try {
      return await fetchWithTimeout(
        init.query ? `${url}?${init.query}` : url,
        {
          method,
          headers: { ...authorization, ...init.headers },
          ...(init.body !== undefined ? { body: init.body } : {}),
        },
        timeoutMs,
      );
    } catch {
      throw new Error(`Couldn't reach the runner at ${base} to ${what}.`);
    }
  };
  const first = await attempt();
  if (first.ok || !credentials?.retry || !(await credentials.retry(first))) return first;
  await first.body?.cancel();
  return attempt();
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** Recovers the hostname from the dialled baseUrl to fill host-less endpoints
 *  announced by the `running` status (the runner can't know which hostname the
 *  client used). Endpoints that already carry an absolute `url` are untouched. */
function extractHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

function fillEndpointHost(status: RunStatus, baseUrl: string): RunStatus {
  if (status.kind !== "running") return status;
  const runnerHost = extractHost(baseUrl);
  // The runner knows the port it published and not the hostname this client
  // reached it by, so an empty host is its way of saying "yours". True of the
  // agent's endpoint for exactly the same reason as an app's.
  const fill = (e: RunnerEndpoint): RunnerEndpoint =>
    e.host === "" ? { ...e, host: runnerHost } : e;
  // The agent's endpoint is dialled, not rendered, so it is completed to a URL
  // here rather than composed by every consumer. The scheme comes from the base
  // URL this client actually reached the runner on — the desktop shell's own
  // page protocol says nothing about how the runner is served.
  const dialable = (e: RunnerEndpoint): RunnerEndpoint => {
    const filled = fill(e);
    if (filled.url) return filled;
    let scheme = "http";
    try {
      scheme = new URL(baseUrl).protocol.replace(/:$/, "") || "http";
    } catch {
      // A malformed base URL is already surfaced by every other request; the
      // default keeps this from throwing on the status path.
    }
    return { ...filled, url: `${scheme}://${filled.host}:${filled.port}` };
  };
  return {
    ...status,
    ...(status.endpoints ? { endpoints: status.endpoints.map(fill) } : {}),
    ...(status.agent ? { agent: dialable(status.agent) } : {}),
  };
}
