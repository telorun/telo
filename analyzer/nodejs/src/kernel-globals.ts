import type { ResourceManifest } from "@telorun/sdk";
import { residualEntrySchemaMap } from "./residual-schema.js";

/**
 * Kernel global names available in every CEL evaluation context at runtime.
 * Both `buildKernelGlobalsSchema` (chain-access validation) and
 * `buildTypedCelEnvironment` in cel-environment.ts (CEL type-checking)
 * must stay in sync with this list.
 *
 * Note: `env` is only available in the root module context. Child modules
 * loaded via Telo.Import do not receive host environment variables.
 * There is no `imports` namespace at runtime — import snapshots are stored
 * under `resources.<alias>`.
 */
export const KERNEL_GLOBAL_NAMES = ["variables", "secrets", "resources", "ports", "env"] as const;

const SYSTEM_KINDS = new Set([
  "Telo.Definition",
  "Telo.Application",
  "Telo.Library",
  "Telo.Abstract",
]);

/**
 * Build a typed JSON Schema describing the kernel globals available in the
 * given manifest set. Used to merge into `x-telo-context` schemas so that
 * chain-access validation recognises kernel globals without module authors
 * having to re-declare them.
 *
 * - `variables` / `secrets`: typed from the root module doc — prefer
 *   Telo.Application when present, otherwise fall back to Telo.Library.
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
    (manifests.find((m) => m.kind === "Telo.Application") as
      | Record<string, any>
      | undefined) ??
    (manifests.find((m) => m.kind === "Telo.Library") as
      | Record<string, any>
      | undefined);

  const resourceProps: Record<string, any> = {};
  for (const m of manifests) {
    const name = m.metadata?.name as string | undefined;
    if (!name || !m.kind) continue;
    // Telo.Import snapshots are stored under resources.<alias> at runtime,
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
      ports: buildPortsSchema(moduleManifest?.ports),
      env: { type: "object", additionalProperties: true },
    },
  };
}

/** Build the closed `ports` chain-access schema: each declared port is an
 *  integer, so `ports.<name>` resolves and `ports.typo` (or member access past
 *  a port, like `ports.http.foo`) is flagged. Falls back to an open map when
 *  the module declares no ports. */
function buildPortsSchema(
  ports: Record<string, any> | null | undefined,
): Record<string, any> {
  if (!ports || typeof ports !== "object" || Array.isArray(ports)) {
    return { type: "object", additionalProperties: true };
  }
  const props: Record<string, any> = {};
  for (const name of Object.keys(ports)) {
    props[name] = { type: "integer" };
  }
  if (Object.keys(props).length === 0) {
    return { type: "object", additionalProperties: true };
  }
  return { type: "object", properties: props, additionalProperties: false };
}

/** Wrap a JSON Schema property map (like `Telo.Application.variables`) into a
 *  closed object schema suitable for chain-access validation. For Application
 *  entries the per-entry shape carries kernel-specific keys (`env`, `default`)
 *  on top of an otherwise-standard JSON Schema property schema; those keys are
 *  stripped via `residualEntrySchemaMap` so CEL sees the coerced shape, not
 *  the env-binding wrapper. Library entries are pure JSON Schema property
 *  schemas and pass through the same call unchanged. Falls back to an open map
 *  when the module declares no variables/secrets. */
function buildSchemaMapSchema(
  schemaMap: Record<string, any> | null | undefined,
): Record<string, any> {
  const props = residualEntrySchemaMap(schemaMap);
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
