import { createHttpRunnerAdapter } from "../http-runner/factory";
import { k8sConfigSchema, k8sDefaultConfig, K8S_REQUEST_CONFIG, type K8sConfig } from "./config-schema";

/** The k8s adapter is the shared HTTP-runner adapter with a minimal config —
 *  just the runner (or control-plane) URL. Image and limits are server-enforced,
 *  not user-pickable, so the request config is fixed. */
export const k8sAdapter = createHttpRunnerAdapter<K8sConfig>({
  id: "k8s",
  displayName: "Kubernetes runner",
  description: "Runs the Application as a sandboxed Kubernetes Pod via a k8s-runner (or Telo Cloud).",
  configSchema: k8sConfigSchema,
  defaultConfig: k8sDefaultConfig,
  startTimeoutMs: 120_000,
  buildRequestConfig() {
    return { ...K8S_REQUEST_CONFIG };
  },
});
