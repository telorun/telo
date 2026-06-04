import type { ConfigIssue } from "../../types";
import { createHttpRunnerAdapter } from "../http-runner/factory";
import {
  dockerApiConfigSchema,
  dockerApiDefaultConfig,
  type DockerApiConfig,
} from "./config-schema";

/** The docker-runner adapter is the shared HTTP-runner adapter with a
 *  docker-specific config (image / pullPolicy / optional registryUrl). */
export const dockerApiAdapter = createHttpRunnerAdapter<DockerApiConfig>({
  id: "docker-api",
  displayName: "Docker runner (HTTP)",
  description: "Runs the Application via a docker-runner HTTP service.",
  configSchema: dockerApiConfigSchema,
  defaultConfig: dockerApiDefaultConfig,
  startTimeoutMs: 90_000,
  validateExtra(config) {
    const issues: ConfigIssue[] = [];
    if (!config.image || config.image.trim() === "") {
      issues.push({ path: "/image", message: "Image is required." });
    }
    if (!["missing", "always", "never"].includes(config.pullPolicy)) {
      issues.push({ path: "/pullPolicy", message: "Pull policy must be one of: missing, always, never." });
    }
    return issues;
  },
  buildRequestConfig(config) {
    const registryUrl = config.registryUrl?.trim();
    return {
      image: config.image,
      pullPolicy: config.pullPolicy,
      ...(registryUrl ? { registryUrl } : {}),
    };
  },
});
