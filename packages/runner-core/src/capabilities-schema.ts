import type { JsonSchema, PullPolicy } from "./contract.js";

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
  /** Override the `pullPolicy` field description. `pullPolicy` semantics differ
   *  per backend (docker: container pull policy; k8s: base-image build
   *  freshness), so each runner can supply wording that matches its behaviour. */
  pullPolicyDescription?: string;
  /** When true, `image` is server-enforced — advertised `readOnly` (locked to
   *  `imageDefault`) so the editor renders it disabled but still sends it. No
   *  effect once `imageEnum` is set (the picker is the constraint). `pullPolicy`
   *  is always client-editable. */
  enforced?: boolean;
  /** Include the optional `registryUrl` field (a runner that forwards a module
   *  registry URL to its workloads). */
  registryUrl?: boolean;
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
  if (opts.registryUrl) {
    properties.registryUrl = {
      type: "string",
      title: "Registry URL",
      description:
        "Optional base URL for the telo module registry, forwarded to the runner as TELO_REGISTRY_URL. Leave blank for the default registry.",
    };
  }
  return {
    type: "object",
    required: ["image", "pullPolicy"],
    properties,
  };
}
