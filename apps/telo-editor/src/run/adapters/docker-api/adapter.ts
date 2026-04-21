import {
  isTerminal,
  type AvailabilityReport,
  type ConfigIssue,
  type RunAdapter,
  type RunEvent,
  type RunSession,
  type RunStatus,
} from "../../types";
import {
  dockerApiConfigSchema,
  dockerApiDefaultConfig,
  type DockerApiConfig,
} from "./config-schema";
import { openSseClient } from "./sse-client";

const HEALTH_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 90_000;

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

function validateBaseUrl(raw: string): ConfigIssue | null {
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export const dockerApiAdapter: RunAdapter<DockerApiConfig> = {
  id: "docker-api",
  displayName: "Docker runner (HTTP)",
  description: "Runs the Application via a docker-runner HTTP service.",

  configSchema: dockerApiConfigSchema,
  defaultConfig: dockerApiDefaultConfig,

  validateConfig(config) {
    const issues: ConfigIssue[] = [];
    const baseUrlIssue = validateBaseUrl(config.baseUrl);
    if (baseUrlIssue) issues.push(baseUrlIssue);
    if (!config.image || config.image.trim() === "") {
      issues.push({ path: "/image", message: "Image is required." });
    }
    if (!["missing", "always", "never"].includes(config.pullPolicy)) {
      issues.push({ path: "/pullPolicy", message: "Pull policy must be one of: missing, always, never." });
    }
    return issues;
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
        remediation: "Start the docker-runner service or fix the URL.",
      };
    }
    if (!healthRes.ok) {
      return {
        status: "unavailable",
        message: `Runner returned HTTP ${healthRes.status} on /v1/health.`,
      };
    }

    let probeRes: Response;
    try {
      probeRes = await fetchWithTimeout(
        `${base}/v1/probe`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: { image: config.image, pullPolicy: config.pullPolicy } }),
        },
        HEALTH_TIMEOUT_MS * 3,
      );
    } catch {
      return {
        status: "unavailable",
        message: `Runner probe call failed at ${config.baseUrl}.`,
      };
    }
    if (!probeRes.ok) {
      return {
        status: "unavailable",
        message: `Runner returned HTTP ${probeRes.status} on /v1/probe.`,
      };
    }
    return (await probeRes.json()) as AvailabilityReport;
  },

  async start(request, config): Promise<RunSession> {
    const base = trimTrailingSlash(config.baseUrl);

    const trimmedRegistryUrl = config.registryUrl?.trim();
    const createRes = await fetchWithTimeout(
      `${base}/v1/sessions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle: request.bundle,
          env: request.env ?? {},
          config: {
            image: config.image,
            pullPolicy: config.pullPolicy,
            ...(trimmedRegistryUrl ? { registryUrl: trimmedRegistryUrl } : {}),
          },
        }),
      },
      START_TIMEOUT_MS,
    );

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

    let currentStatus: RunStatus = { kind: "starting" };
    const subscribers = new Set<(event: RunEvent) => void>();
    const emit = (event: RunEvent): void => {
      for (const sub of subscribers) sub(event);
    };

    const client = openSseClient({
      url: `${base}${streamUrl}`,
      sessionId,
      onEvent: (event) => {
        if (event.type === "status") currentStatus = event.status;
        emit(event);
      },
      onError: () => {
        if (isTerminal(currentStatus)) return;
        const failed: RunStatus = { kind: "failed", message: "Runner stream closed unexpectedly." };
        currentStatus = failed;
        emit({ type: "status", status: failed });
      },
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
      async stop() {
        try {
          await fetchWithTimeout(
            `${base}/v1/sessions/${sessionId}`,
            { method: "DELETE" },
            HEALTH_TIMEOUT_MS * 3,
          );
          // Close the SSE client only after DELETE returns. If the DELETE
          // succeeds, the server will emit a final `stopped` status that our
          // status handler consumes and self-closes the client. If the
          // DELETE throws, we close explicitly to avoid a dangling stream.
        } catch (err) {
          client.close();
          throw err;
        }
      },
    };
  },
};
