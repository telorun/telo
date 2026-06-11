import type { JsonSchema, PullPolicy } from "./contract.js";

export interface SessionConfigSchemaOptions {
  /** Default container image; becomes the field's advertised `default`. */
  imageDefault: string;
  /** Default pull policy (defaults to `missing`). */
  pullPolicyDefault?: PullPolicy;
  /** When true, `image`/`pullPolicy` are server-enforced — advertised
   *  `readOnly` so the editor renders them disabled but still sends them. */
  enforced?: boolean;
  /** Include the optional `registryUrl` field (a runner that forwards a module
   *  registry URL to its workloads). */
  registryUrl?: boolean;
}

/**
 * Builds the JSON Schema a runner advertises on `/v1/capabilities` for the
 * editable `SessionConfig` surface. `baseUrl` is deliberately absent — the
 * client owns it. Server-enforced runners pass `enforced: true` to lock
 * `image`/`pullPolicy` as `readOnly` (the value still travels on the wire).
 */
export function sessionConfigSchema(opts: SessionConfigSchemaOptions): JsonSchema {
  const readOnly = opts.enforced === true;
  const properties: Record<string, JsonSchema> = {
    image: {
      type: "string",
      minLength: 1,
      default: opts.imageDefault,
      title: "Image",
      description: "Container image the runner spawns for each run.",
      ...(readOnly ? { readOnly: true } : {}),
    },
    pullPolicy: {
      type: "string",
      enum: ["missing", "always", "never"],
      default: opts.pullPolicyDefault ?? "missing",
      title: "Pull policy",
      description:
        "`missing` pulls on first use; `always` forces a pull every run; `never` fails if the image isn't present.",
      ...(readOnly ? { readOnly: true } : {}),
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
