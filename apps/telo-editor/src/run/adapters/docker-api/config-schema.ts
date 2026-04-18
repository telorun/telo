import type { JSONSchema7 } from "json-schema";

export interface DockerApiConfig {
  baseUrl: string;
  image: string;
  pullPolicy: "missing" | "always" | "never";
  registryUrl?: string;
}

const RUNNER_URL_FROM_ENV =
  (import.meta.env as Record<string, string | undefined>).VITE_TELO_RUNNER_URL;

export const dockerApiDefaultConfig: DockerApiConfig = {
  baseUrl: RUNNER_URL_FROM_ENV && RUNNER_URL_FROM_ENV.trim() !== ""
    ? RUNNER_URL_FROM_ENV
    : "http://localhost:8061",
  image: "telorun/telo:nodejs",
  pullPolicy: "missing",
};

export const dockerApiConfigSchema: JSONSchema7 = {
  type: "object",
  required: ["baseUrl", "image", "pullPolicy"],
  properties: {
    baseUrl: {
      type: "string",
      minLength: 1,
      default: dockerApiDefaultConfig.baseUrl,
      title: "Runner URL",
      description:
        "Base URL of the docker-runner HTTP service, e.g. http://runner:8061 (compose) or http://localhost:8061 (standalone).",
    },
    image: {
      type: "string",
      minLength: 1,
      default: dockerApiDefaultConfig.image,
      title: "Image",
      description: "Docker image the runner should spawn for each run.",
    },
    pullPolicy: {
      type: "string",
      enum: ["missing", "always", "never"],
      default: dockerApiDefaultConfig.pullPolicy,
      title: "Pull policy",
      description:
        "`missing` pulls on first use; `always` forces a pull every run; `never` fails if the image isn't present on the runner's daemon.",
    },
    registryUrl: {
      type: "string",
      title: "Registry URL",
      description:
        "Optional base URL for the telo module registry. Forwarded to the runner as TELO_REGISTRY_URL. Leave blank to use the telo default registry.",
    },
  },
};
