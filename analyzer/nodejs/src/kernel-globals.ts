import type { ResourceManifest } from "@telorun/sdk";

/**
 * Kernel global names available in every CEL evaluation context at runtime.
 * Both `buildKernelGlobalsSchema` (chain-access validation) and
 * `buildTypedCelEnvironment` in cel-environment.ts (CEL type-checking)
 * must stay in sync with this list.
 *
 * Note: `env` is only available in the root module context. Child modules
 * loaded via Kernel.Import do not receive host environment variables.
 * There is no `imports` namespace at runtime — import snapshots are stored
 * under `resources.<alias>`.
 */
export const KERNEL_GLOBAL_NAMES = ["variables", "secrets", "resources", "env"] as const;

const SYSTEM_KINDS = new Set([
  "Kernel.Definition",
  "Kernel.Application",
  "Kernel.Library",
  "Kernel.Abstract",
]);

/**
 * Build a typed JSON Schema describing the kernel globals available in the
 * given manifest set. Used to merge into `x-telo-context` schemas so that
 * chain-access validation recognises kernel globals without module authors
 * having to re-declare them.
 *
 * - `variables` / `secrets`: typed from the root module doc — prefer
 *   Kernel.Application when present, otherwise fall back to Kernel.Library.
 *   Applications are the root whose variables/secrets contract governs CEL
 *   in the outer module; Libraries are only relevant when the caller scoped
 *   the manifest list to a single library's file.
 * - `resources`: enumerates all non-system resource names
 * - `env`: dynamic (runtime env vars, root module only)
 */
export function buildKernelGlobalsSchema(
  manifests: ResourceManifest[],
): Record<string, any> {
  const moduleManifest =
    (manifests.find((m) => m.kind === "Kernel.Application") as
      | Record<string, any>
      | undefined) ??
    (manifests.find((m) => m.kind === "Kernel.Library") as
      | Record<string, any>
      | undefined);

  const resourceProps: Record<string, any> = {};
  for (const m of manifests) {
    const name = m.metadata?.name as string | undefined;
    if (!name || !m.kind) continue;
    // Kernel.Import snapshots are stored under resources.<alias> at runtime,
    // so they appear here alongside regular resources.
    if (!SYSTEM_KINDS.has(m.kind)) {
      resourceProps[name] = { type: "object", additionalProperties: true };
    }
  }

  return {
    type: "object",
    properties: {
      variables: buildSchemaMapSchema(moduleManifest?.variables),
      secrets: buildSchemaMapSchema(moduleManifest?.secrets),
      resources: {
        type: "object",
        properties: resourceProps,
        additionalProperties: false,
      },
      env: { type: "object", additionalProperties: true },
    },
  };
}

/** Wrap a JSON Schema property map (like `Kernel.Application.variables`) into a
 *  closed object schema suitable for chain-access validation. Falls back to
 *  an open map when the module declares no variables/secrets. */
function buildSchemaMapSchema(
  schemaMap: Record<string, any> | null | undefined,
): Record<string, any> {
  if (!schemaMap || typeof schemaMap !== "object" || Array.isArray(schemaMap)) {
    return { type: "object", additionalProperties: true };
  }
  const props: Record<string, any> = {};
  for (const [key, value] of Object.entries(schemaMap)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      props[key] = value;
    }
  }
  if (Object.keys(props).length === 0) {
    return { type: "object", additionalProperties: true };
  }
  return {
    type: "object",
    properties: props,
    additionalProperties: false,
  };
}

/**
 * Merge kernel globals into an `x-telo-context` schema so chain-access
 * validation recognises `variables`, `secrets`, `resources`, `env`
 * without module authors having to re-declare them.
 *
 * Context-specific properties take precedence over globals (spread order).
 * The original `additionalProperties` setting is preserved.
 */
export function mergeKernelGlobalsIntoContext(
  contextSchema: Record<string, any>,
  globalsSchema: Record<string, any>,
): Record<string, any> {
  return {
    ...contextSchema,
    properties: {
      ...globalsSchema.properties,
      ...(contextSchema.properties ?? {}),
    },
    additionalProperties: contextSchema.additionalProperties ?? false,
  };
}
