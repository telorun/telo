import type { JSONSchema7 } from "json-schema";

import {
  isTerminal,
  TermsRequiredError,
  type AvailabilityReport,
  type ConfigIssue,
  type RunAdapter,
  type RunEvent,
  type RunnerCapabilities,
  type RunnerTerms,
  type RunSession,
  type RunStatus,
} from "../../types";
import { makeHttpRunnerIo } from "./io-client";
import { openSseClient } from "./sse-client";

const HEALTH_TIMEOUT_MS = 2_000;

/** Wire header carrying the accepted terms version (mirrors runner-core's
 *  `ACCEPTED_TERMS_HEADER`). Kept as a local constant so editor code doesn't
 *  depend on the Node-only `@telorun/runner-core` package. */
const ACCEPTED_TERMS_HEADER = "x-telo-accepted-terms";

interface CreateSessionResponse {
  sessionId: string;
  streamUrl: string;
  createdAt: string;
}

interface ErrorResponse {
  error: string;
  message?: string;
  stage?: string;
  daemonMessage?: string;
}

/**
 * Every runner adapter speaks the identical `/v1` HTTP+SSE contract — they
 * differ only in their config shape and the `config` payload they send. This
 * factory owns the shared wire logic (health/probe, session start, SSE +
 * WebSocket PTY wiring) so docker-runner and k8s adapters can't drift, mirroring
 * the server-side runner-core extraction.
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
      return (await probeRes.json()) as AvailabilityReport;
    },

    async getTerms(config): Promise<RunnerTerms | null> {
      if (validateBaseUrl(config.baseUrl)) return null;
      const base = trimTrailingSlash(config.baseUrl);
      let res: Response;
      try {
        res = await fetchWithTimeout(`${base}/v1/capabilities`, { method: "GET" }, HEALTH_TIMEOUT_MS);
      } catch {
        throw new Error(`Couldn't reach the runner at ${config.baseUrl}.`);
      }
      // 404 = older runner without capabilities → treat as no terms.
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Runner returned HTTP ${res.status} on /v1/capabilities.`);
      }
      try {
        return ((await res.json()) as RunnerCapabilities).terms ?? null;
      } catch {
        throw new Error("Runner returned a malformed /v1/capabilities document.");
      }
    },

    async start(request, config): Promise<RunSession> {
      const base = trimTrailingSlash(config.baseUrl);
      const runnerHost = extractHost(config.baseUrl);

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (request.acceptedTermsVersion) {
        headers[ACCEPTED_TERMS_HEADER] = request.acceptedTermsVersion;
      }

      const createRes = await fetchWithTimeout(
        `${base}/v1/sessions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            bundle: request.bundle,
            env: request.env ?? {},
            ports: request.ports ?? [],
            config: opts.buildRequestConfig(config),
            // Always request the debug stream so the run view's Debug panel is
            // populated; the runner relays it over this same session stream.
            inspect: true,
          }),
        },
        opts.startTimeoutMs,
      );

      // The runner enforces its terms — if unacknowledged it replies 428 with the
      // current terms. Surface them so the caller can gate and retry.
      if (createRes.status === 428) {
        let payload: { terms?: RunnerTerms } | null = null;
        try {
          payload = (await createRes.json()) as { terms?: RunnerTerms };
        } catch {
          // fall through to a generic error below
        }
        if (payload?.terms) throw new TermsRequiredError(payload.terms);
        throw new Error("Runner requires accepting its terms before running.");
      }

      if (!createRes.ok) {
        let err: ErrorResponse | null = null;
        try {
          err = (await createRes.json()) as ErrorResponse;
        } catch {
          // fall through
        }
        const message = err?.daemonMessage ?? err?.message ?? `runner returned HTTP ${createRes.status}`;
        throw new Error(message);
      }

      const { sessionId, streamUrl } = (await createRes.json()) as CreateSessionResponse;
      return buildSession({
        base,
        runnerHost,
        sessionId,
        streamUrl,
        initialStatus: { kind: "starting" },
      });
    },

    async attach(sessionId, config): Promise<RunSession | null> {
      const base = trimTrailingSlash(config.baseUrl);
      const runnerHost = extractHost(config.baseUrl);

      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${base}/v1/sessions/${sessionId}`,
          { method: "GET" },
          HEALTH_TIMEOUT_MS * 3,
        );
      } catch {
        throw new Error(`Couldn't reach the runner at ${config.baseUrl}.`);
      }
      // The session is gone — evicted past its TTL, or the runner restarted.
      // The caller keeps the history entry but marks it unavailable.
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Runner returned HTTP ${res.status} on /v1/sessions/${sessionId}.`);
      }
      const { status } = (await res.json()) as { status: RunStatus };

      return buildSession({
        base,
        runnerHost,
        sessionId,
        streamUrl: `/v1/sessions/${sessionId}/events`,
        initialStatus: fillEndpointHost(status, runnerHost),
        // The re-hydrated record is empty, so replay console + events from the
        // start instead of from the prior tab's checkpoint.
        replayFromStart: true,
      });
    },
  };
}

interface BuildSessionArgs {
  base: string;
  runnerHost: string;
  sessionId: string;
  streamUrl: string;
  initialStatus: RunStatus;
  replayFromStart?: boolean;
}

/** Wires the SSE event stream + WebSocket PTY channel for a session that already
 *  exists on the runner, shared by `start` (fresh POST) and `attach` (resume
 *  after reload). The only difference between the two is where the session id
 *  comes from and whether replay starts from zero. */
function buildSession(args: BuildSessionArgs): RunSession {
  const { base, runnerHost, sessionId, streamUrl, initialStatus, replayFromStart } = args;

  let currentStatus: RunStatus = initialStatus;
  const subscribers = new Set<(event: RunEvent) => void>();
  const emit = (event: RunEvent): void => {
    for (const sub of subscribers) sub(event);
  };

  const client = openSseClient({
    url: `${base}${streamUrl}`,
    sessionId,
    replayFromStart,
    onEvent: (event) => {
      const next =
        event.type === "status"
          ? { ...event, status: fillEndpointHost(event.status, runnerHost) }
          : event;
      if (next.type === "status") currentStatus = next.status;
      emit(next);
    },
    onError: () => {
      if (isTerminal(currentStatus)) return;
      const failed: RunStatus = { kind: "failed", message: "Runner stream closed unexpectedly." };
      currentStatus = failed;
      emit({ type: "status", status: failed });
    },
  });

  const wsBase = base.replace(/^http(s?):/i, "ws$1:");
  const io = makeHttpRunnerIo({
    url: `${wsBase}/v1/sessions/${sessionId}/io`,
    sessionId,
    replayFromStart,
  });

  return {
    id: sessionId,
    getStatus: () => currentStatus,
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    io,
    async stop() {
      try {
        await fetchWithTimeout(`${base}/v1/sessions/${sessionId}`, { method: "DELETE" }, HEALTH_TIMEOUT_MS * 3);
      } catch (err) {
        client.close();
        throw err;
      }
    },
  };
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

function fillEndpointHost(status: RunStatus, runnerHost: string): RunStatus {
  if (status.kind !== "running" || !status.endpoints) return status;
  return {
    ...status,
    endpoints: status.endpoints.map((e) => (e.host === "" ? { ...e, host: runnerHost } : e)),
  };
}
