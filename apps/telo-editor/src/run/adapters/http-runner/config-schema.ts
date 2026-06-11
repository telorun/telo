import type { JSONSchema7 } from "json-schema";

/**
 * The unified HTTP-runner config. `baseUrl` is the one client-owned field (you
 * need it to reach the runner, so the runner can't advertise it). Everything
 * else is dynamic — the form merges in the runner's advertised capability
 * schema (`image`, `pullPolicy`, `registryUrl`, …) once `baseUrl` is reachable.
 */
export interface HttpRunnerConfig {
  baseUrl: string;
  [key: string]: unknown;
}

const RUNNER_URL_FROM_ENV = (import.meta.env as Record<string, string | undefined>)
  .VITE_TELO_RUNNER_URL;

/** Default runner: the hosted Telo Cloud runner. Overridable via env for local
 *  development against a docker-runner / k8s-runner. */
export const DEFAULT_RUNNER_URL =
  RUNNER_URL_FROM_ENV && RUNNER_URL_FROM_ENV.trim() !== ""
    ? RUNNER_URL_FROM_ENV
    : "https://runner.telo.run";

export const httpRunnerDefaultConfig: HttpRunnerConfig = {
  baseUrl: DEFAULT_RUNNER_URL,
};

/** Bootstrap schema: just `baseUrl`. The form fetches `/v1/capabilities` and
 *  merges the runner's advertised editable fields on top of this. */
export const httpRunnerConfigSchema: JSONSchema7 = {
  type: "object",
  required: ["baseUrl"],
  properties: {
    baseUrl: {
      type: "string",
      minLength: 1,
      default: DEFAULT_RUNNER_URL,
      title: "Runner URL",
      description:
        "Base URL of the runner's HTTP service (docker-runner, k8s-runner, or a Telo Cloud control plane). The runner advertises its own editable config once reachable.",
    },
  },
};

/**
 * Fields a pre-capabilities runner (no `/v1/capabilities`) still requires on the
 * session body. Used only as a fallback floor — when capabilities load, the
 * form-collected `image`/`pullPolicy` override these.
 */
export const FALLBACK_SESSION_CONFIG = {
  image: "telorun/node:0-slim",
  pullPolicy: "missing" as const,
};
