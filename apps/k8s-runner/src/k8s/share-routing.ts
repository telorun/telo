import type { ShareRouting } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../config.js";
import { publicUrlTemplateEnv } from "./routing/session-endpoints.js";

/**
 * The k8s runner routes shares only through a chosen layer and a base domain:
 * the chart's wildcard `*.<baseDomain>` route reaches the relay, which also
 * serves the tunnel at `tunnel.<baseDomain>`. A share's host is its id in the
 * place of a session's, so the session templates apply unchanged.
 */
export function kubernetesShareRouting(config: K8sRunnerConfig): ShareRouting | undefined {
  const { mode, baseDomain } = config.sessionRouting;
  if ((mode !== "ingress" && mode !== "gateway") || !baseDomain) return undefined;
  return {
    baseDomain,
    addresses(shareId) {
      const env = publicUrlTemplateEnv(config, shareId);
      return {
        publicUrlTemplate: env.TELO_HOST_PUBLIC_URL_TEMPLATE!,
        publicUrlSecondaryTemplate: env.TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE!,
        tunnelUrl: `wss://tunnel.${baseDomain}/v1/shares/${shareId}/tunnel`,
      };
    },
  };
}
