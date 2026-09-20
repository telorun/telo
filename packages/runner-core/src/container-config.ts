import type { JsonSchema, PullPolicy, SessionConfig } from "./contract.js";

/**
 * The session config of a backend that runs CONTAINERS — the schema it
 * advertises on `/v1/capabilities` and the parser it reads the same fields back
 * with. Two halves of one statement, in one file, so a field cannot be
 * advertised in a shape the backend does not accept.
 *
 * It lives here rather than in the contract because it is not universal: a
 * backend that runs local processes has no image to name. `SessionConfig` is
 * opaque to core, and this is what the two container backends narrow it with.
 */

export interface SessionConfigSchemaOptions {
  /** Default container image; becomes the field's advertised `default`. */
  imageDefault: string;
  /** When set (and non-empty), constrains `image` to this allowlist — advertised
   *  as a JSON Schema `enum` so the editor renders a base-image picker. The
   *  picker is editable within the list, so an `imageEnum` overrides `enforced`
   *  for the `image` field (a one-entry enum is effectively locked anyway). */
  imageEnum?: string[];
  /** Default pull policy (defaults to `missing`). */
  pullPolicyDefault?: PullPolicy;
  /** Override the `pullPolicy` field description. Wording differs per backend
   *  (a container pull policy on docker, a Pod `imagePullPolicy` on k8s), so
   *  each runner can supply text that matches what its workload sees. */
  pullPolicyDescription?: string;
  /** When true, `image` is server-enforced — advertised `readOnly` (locked to
   *  `imageDefault`) so the editor renders it disabled but still sends it. No
   *  effect once `imageEnum` is set (the picker is the constraint). `pullPolicy`
   *  is always client-editable. */
  enforced?: boolean;
}

/**
 * Builds the JSON Schema a runner advertises on `/v1/capabilities` for the
 * editable `SessionConfig` surface. `baseUrl` is deliberately absent — the
 * client owns it. Server-enforced runners pass `enforced: true` to lock `image`
 * as `readOnly` (the value still travels on the wire); `pullPolicy` is always
 * client-editable.
 */
export function sessionConfigSchema(opts: SessionConfigSchemaOptions): JsonSchema {
  const readOnly = opts.enforced === true;
  const hasEnum = Array.isArray(opts.imageEnum) && opts.imageEnum.length > 0;
  const properties: Record<string, JsonSchema> = {
    image: {
      type: "string",
      minLength: 1,
      default: opts.imageDefault,
      title: "Image",
      description: "Container image the runner spawns for each run.",
      // An allowlist renders as an editable picker; otherwise fall back to the
      // enforced (readOnly) single value.
      ...(hasEnum ? { enum: opts.imageEnum } : readOnly ? { readOnly: true } : {}),
    },
    pullPolicy: {
      type: "string",
      enum: ["missing", "always", "never"],
      default: opts.pullPolicyDefault ?? "missing",
      title: "Pull policy",
      description:
        opts.pullPolicyDescription ??
        "`missing` pulls on first use; `always` forces a pull every run; `never` fails if the image isn't present.",
    },
  };
  return {
    type: "object",
    required: ["image", "pullPolicy"],
    properties,
  };
}

/** What a container backend needs out of a session config. */
export interface ContainerConfig {
  image: string;
  pullPolicy: PullPolicy;
}

const PULL_POLICIES: readonly PullPolicy[] = ["missing", "always", "never"];

/**
 * The `validateConfig` gate for a container backend: the message a bad config is
 * rejected with (`400 invalid_config`), or `undefined` when it is usable.
 *
 * The route used to enforce these two fields through its own body schema. It no
 * longer knows them, so the runner that DOES know them says so — which is also
 * what keeps the rejection a 400 naming the field rather than a start failure
 * arriving on the event stream.
 */
export function validateContainerConfig(config: SessionConfig): string | undefined {
  const image = config.image;
  if (typeof image !== "string" || image.trim() === "") {
    return "`config.image` is required: this runner spawns a container per run and needs the image to run.";
  }
  const pullPolicy = config.pullPolicy;
  if (pullPolicy !== undefined && !PULL_POLICIES.includes(pullPolicy as PullPolicy)) {
    return `\`config.pullPolicy\` must be one of ${PULL_POLICIES.join(", ")}.`;
  }
  return undefined;
}

/**
 * The gate for a backend that supplies its own image when the client names none
 * (k8s falls back to its operator-configured default image). ABSENT is fine;
 * present-and-wrong is not — a config the backend cannot honour has to be
 * refused rather than coerced, or `{"image": 42, "pullPolicy": "sometimes"}`
 * starts a pod on the default image under the wrong policy and tells nobody.
 */
export function validateOptionalContainerConfig(config: SessionConfig): string | undefined {
  if (config.image !== undefined && (typeof config.image !== "string" || config.image.trim() === "")) {
    return "`config.image` must be a non-empty string when given; omit it to use this runner's default image.";
  }
  const pullPolicy = config.pullPolicy;
  if (pullPolicy !== undefined && !PULL_POLICIES.includes(pullPolicy as PullPolicy)) {
    return `\`config.pullPolicy\` must be one of ${PULL_POLICIES.join(", ")}.`;
  }
  return undefined;
}

/**
 * The same narrowing as {@link containerConfig} for that backend. It THROWS on a
 * value it cannot use, exactly as `containerConfig` does: only the gate above
 * decides whether a config is acceptable, so a reader that silently substituted
 * a default would make the gate optional in practice.
 */
export function optionalContainerConfig(
  config: SessionConfig,
): { image?: string; pullPolicy: PullPolicy } {
  const invalid = validateOptionalContainerConfig(config);
  if (invalid) throw new Error(invalid);
  return {
    image: config.image as string | undefined,
    pullPolicy: (config.pullPolicy as PullPolicy | undefined) ?? "missing",
  };
}

/**
 * Narrow a session config to what a container backend runs on. Throws rather
 * than defaulting an image: a backend reaching here with no image was let
 * through by a gate that should have refused it, and inventing one would start
 * a workload nobody asked for.
 */
export function containerConfig(config: SessionConfig): ContainerConfig {
  const invalid = validateContainerConfig(config);
  if (invalid) throw new Error(invalid);
  return {
    image: config.image as string,
    pullPolicy: (config.pullPolicy as PullPolicy | undefined) ?? "missing",
  };
}
