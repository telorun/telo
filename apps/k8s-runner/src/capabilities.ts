import {
  sessionConfigSchema,
  type RunnerCapabilities,
  type RunnerTerms,
} from "@telorun/runner-core";

export interface KubernetesRunnerCapabilitiesOptions {
  /** Identity shown as the runner's label in studio; operator-configurable
   *  via RUNNER_DISPLAY_NAME / RUNNER_DESCRIPTION. */
  displayName: string;
  description: string;
  defaultImage: string;
  terms?: RunnerTerms;
  imageEnum?: string[];
  /** Whether the operator enabled watch sessions. Advertised so a client knows
   *  before it asks — a runner with watch off rejects the field. */
  watch: boolean;
  /** Catalog names admissible as a session's co-resident `agent`. */
  agents?: string[];
}

/** What k8s-runner advertises on `/v1/capabilities`. The runner serves
 *  untrusted/anonymous code under a hard-ceiling policy. `image` is a base-image
 *  picker: when an `imageEnum` is supplied (the resolved Docker Hub catalog) the
 *  studio renders an editable dropdown constrained to that allowlist — which the
 *  session route re-validates server-side. Without a catalog (disabled /
 *  first-fetch failure) the list collapses to the single `defaultImage` (locked
 *  via `enforced`). `pullPolicy` is client-editable: `always` re-pulls the base
 *  image when its tag has moved upstream (rebuilding the per-app image), which
 *  is how a picked moving tag like `latest-slim` stays current.
 *
 *  `terms`, when set (operator-provided via RUNNER_TERMS_*), are enforced: a
 *  session won't start until the client acknowledges the current version. */
export function kubernetesRunnerCapabilities(
  opts: KubernetesRunnerCapabilitiesOptions,
): RunnerCapabilities {
  const { displayName, description, defaultImage, terms, imageEnum } = opts;
  return {
    displayName,
    description,
    features: {
      // Both attach modes: the kubernetes attach subresource without a TTY
      // already gives separate stdout and stderr channels, so `streams` invents
      // nothing at the transport layer.
      io: ["tty", "streams"],
      ports: true,
      watch: opts.watch,
      ...(opts.agents && opts.agents.length > 0 ? { agents: opts.agents } : {}),
    },
    config: {
      schema: sessionConfigSchema({
        imageDefault: defaultImage,
        enforced: true,
        imageEnum,
        pullPolicyDescription:
          "Base-image freshness. `always` rebuilds the session image when the base tag has moved upstream (Docker Hub only); `missing` and `never` reuse the cached build.",
      }),
    },
    terms,
  };
}
