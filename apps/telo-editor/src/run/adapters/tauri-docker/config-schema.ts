import type { JSONSchema7 } from "json-schema";

export interface TauriDockerConfig {
  image: string;
  pullPolicy: "missing" | "always" | "never";
  /** Optional override — forwards as DOCKER_HOST env to every docker
   *  invocation (run, kill, version, inspect). Blank string means "use
   *  docker's default socket detection." */
  dockerHost?: string;
}

export const tauriDockerDefaultConfig: TauriDockerConfig = {
  image: "telorun/telo:nodejs",
  pullPolicy: "missing",
};

export const tauriDockerConfigSchema: JSONSchema7 = {
  type: "object",
  required: ["image", "pullPolicy"],
  properties: {
    image: {
      type: "string",
      minLength: 1,
      default: "telorun/telo:nodejs",
      title: "Image",
      description: "Docker image implementing the telo CLI entrypoint.",
    },
    pullPolicy: {
      type: "string",
      enum: ["missing", "always", "never"],
      default: "missing",
      title: "Pull policy",
      description:
        "`missing` lets docker pull on first use; `always` forces a pull on every run; `never` fails if the image isn't present locally.",
    },
    dockerHost: {
      type: "string",
      title: "Docker host",
      description:
        "Override DOCKER_HOST (e.g. unix:///var/run/docker.sock). Leave blank to use the default.",
    },
  },
};
