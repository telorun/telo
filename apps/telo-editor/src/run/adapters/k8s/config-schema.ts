import type { JSONSchema7 } from "json-schema";

/**
 * The k8s adapter's config is deliberately minimal — just the runner (or
 * control-plane) URL. Image and resource limits are server-enforced, not
 * user-pickable, because the runner serves untrusted/anonymous code under a
 * hard-ceiling policy. The adapter can't tell a bare k8s-runner from a Telo
 * Cloud control plane fronting it; both speak the same /v1 contract.
 */
export interface K8sConfig {
  baseUrl: string;
}

const RUNNER_URL_FROM_ENV =
  (import.meta.env as Record<string, string | undefined>).VITE_TELO_K8S_RUNNER_URL;

export const k8sDefaultConfig: K8sConfig = {
  baseUrl:
    RUNNER_URL_FROM_ENV && RUNNER_URL_FROM_ENV.trim() !== ""
      ? RUNNER_URL_FROM_ENV
      : "http://localhost:8062",
};

export const k8sConfigSchema: JSONSchema7 = {
  type: "object",
  required: ["baseUrl"],
  properties: {
    baseUrl: {
      type: "string",
      minLength: 1,
      default: k8sDefaultConfig.baseUrl,
      title: "Runner URL",
      description:
        "Base URL of the k8s-runner HTTP service or the Telo Cloud control plane fronting it. Resource limits and image are enforced by the server.",
    },
  },
};

/** Fixed request config sent to the runner. The server treats image as a
 *  default it may override and applies its own hard limit ceilings, so these
 *  values are not user-facing. */
export const K8S_REQUEST_CONFIG = {
  image: "telorun/node:latest-slim",
  pullPolicy: "missing" as const,
};
