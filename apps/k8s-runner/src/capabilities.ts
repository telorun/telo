import {
  sessionConfigSchema,
  type RunnerCapabilities,
  type RunnerTerms,
} from "@telorun/runner-core";

/** What k8s-runner advertises on `/v1/capabilities`. The runner serves
 *  untrusted/anonymous code under a hard-ceiling policy. `image` is a base-image
 *  picker: when an `imageEnum` is supplied (the resolved Docker Hub catalog) the
 *  editor renders an editable dropdown constrained to that allowlist — which the
 *  session route re-validates server-side. Without a catalog (disabled /
 *  first-fetch failure) the list collapses to the single `defaultImage` (locked
 *  via `enforced`). `pullPolicy` is client-editable: `always` re-pulls the base
 *  image when its tag has moved upstream (rebuilding the per-app image), which
 *  is how a picked moving tag like `latest-slim` stays current.
 *
 *  `terms`, when set (operator-provided via RUNNER_TERMS_*), are enforced: a
 *  session won't start until the client acknowledges the current version. */
export function kubernetesRunnerCapabilities(
  defaultImage: string,
  terms?: RunnerTerms,
  imageEnum?: string[],
): RunnerCapabilities {
  return {
    displayName: "Telo Public Cloud",
    description:
      "Runs the Telo application in sandboxed cloud environment with capped CPU and memory.",
    config: {
      schema: sessionConfigSchema({
        imageDefault: defaultImage,
        enforced: true,
        imageEnum,
        pullPolicyDescription:
          "Base-image freshness. `always` rebuilds the session image when the base tag has moved upstream (Docker Hub only); `missing` and `never` reuse the cached build.",
      }),
    },
    features: { io: true, ports: true },
    terms,
  };
}
