import { createHttpRunnerAdapter } from "./factory";
import {
  FALLBACK_SESSION_CONFIG,
  httpRunnerConfigSchema,
  httpRunnerDefaultConfig,
  type HttpRunnerConfig,
} from "./config-schema";

/** The single, backend-neutral HTTP-runner adapter. It speaks the `/v1`
 *  contract and discovers its editable config from the runner's
 *  `/v1/capabilities` document, so it serves docker-runner, k8s-runner, and the
 *  Telo Cloud control plane without per-backend knowledge. */
export const httpRunnerAdapter = createHttpRunnerAdapter<HttpRunnerConfig>({
  id: "http-runner",
  displayName: "HTTP runner",
  description: "Runs the Application via a runner's HTTP service.",
  configSchema: httpRunnerConfigSchema,
  defaultConfig: httpRunnerDefaultConfig,
  startTimeoutMs: 120_000,
  buildRequestConfig(config) {
    const { baseUrl: _baseUrl, ...rest } = config;
    return { ...FALLBACK_SESSION_CONFIG, ...rest };
  },
});
