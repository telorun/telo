import { sessionConfigSchema, type RunnerCapabilities } from "@telorun/runner-core";

/** What k8s-runner advertises on `/v1/capabilities`. The runner serves
 *  untrusted/anonymous code under a hard-ceiling policy, so image and pull
 *  policy are server-enforced — advertised `readOnly` (the enforced image is the
 *  runner's `defaultImage`). The user edits only the runner URL. */
export function kubernetesRunnerCapabilities(defaultImage: string): RunnerCapabilities {
  return {
    displayName: "Telo Public Cloud",
    description:
      "Runs the Telo application in sandboxed cloud environment with capped CPU and memory.",
    config: {
      schema: sessionConfigSchema({ imageDefault: defaultImage, enforced: true }),
    },
    features: { io: true, ports: true },
  };
}
