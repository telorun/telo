import type { JSONSchema7 } from "json-schema";

/**
 * Session config for the editor-managed local docker-runner — the same shape
 * docker-runner advertises on `/v1/capabilities` (image, pullPolicy, …), which
 * the form merges in once the runner is up. Unlike `HttpRunnerConfig` there is
 * no `baseUrl`: the supervisor owns where the runner listens and the adapter
 * injects it per call.
 */
export interface LocalDockerConfig {
  image: string;
  pullPolicy: "missing" | "always" | "never";
  [key: string]: unknown;
}

export const localDockerDefaultConfig: LocalDockerConfig = {
  image: "telorun/node:0-slim",
  pullPolicy: "missing",
};

export const localDockerConfigSchema: JSONSchema7 = {
  type: "object",
  required: ["image", "pullPolicy"],
  properties: {
    image: {
      type: "string",
      minLength: 1,
      default: localDockerDefaultConfig.image,
      title: "Image",
      description: "Docker image implementing the telo CLI entrypoint.",
    },
    pullPolicy: {
      type: "string",
      enum: ["missing", "always", "never"],
      default: localDockerDefaultConfig.pullPolicy,
      title: "Pull policy",
      description:
        "`missing` lets docker pull on first use; `always` forces a pull on every run; `never` fails if the image isn't present locally.",
    },
  },
};
