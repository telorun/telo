import type { ResourceManifest } from "@telorun/sdk";
import { moduleMetadataSchema } from "./module-metadata-scope.js";
import { residualEntrySchemaMap } from "./residual-schema.js";
import { applyObservedStateNode } from "./validate-observed-state.js";

/**
 * Kernel global names available in every CEL evaluation context at runtime.
 * Both `buildKernelGlobalsSchema` (chain-access validation) and
 * `buildTypedCelEnvironment` in cel-environment.ts (CEL type-checking)
 * must stay in sync with this list.
 *
 * Note: there is no `imports` namespace at runtime — import snapshots are
 * stored under `resources.<alias>`. Host environment variables are reached
 * by declaring a typed `variables:`/`secrets:` entry with an `env:` binding
 * and referencing `variables.X` / `secrets.X`.
 */
export const KERNEL_GLOBAL_NAMES = [
  "variables",
  "secrets",
  "resources",
  "ports",
  "module",
] as const;

const SYSTEM_KINDS = new Set([
  "Telo.Definition",
  "Telo.Application",
  "Telo.Library",
  "Telo.Abstract",
]);

/** Kernel globals as ONE resource's declaring module sees them. */
export interface KernelGlobalsIndex {
  forResource(m: ResourceManifest): Record<string, any>;
}

/**
 * Build the typed JSON Schema describing the kernel globals available to each
 * resource in a manifest set. Used to merge into `x-telo-context` schemas so
 * that chain-access validation recognises kernel globals without module authors
 * having to re-declare them.
 *
 * `variables` / `secrets` / `ports` are typed **per declaring module**, because
 * that is the contract the resource's CEL is evaluated against at runtime. An
 * application analysis is flattened — `selectModuleManifestsForAnalysis` drops
 * an imported library's module doc and carries its config blocks across as
 * `metadata.moduleGlobals` instead — so a resource forwarded from a library is
 * typed from that stamp, and everything else from the entry module's own doc
 * (the only module doc left in the set).
 *
 * Typing every resource from the entry doc is what made a library's
 * `variables.x` a hard error the library author could not act on, and — in the
 * other direction — let a library read a variable it never declared whenever the
 * app happened to declare that name.
 *
 * `resources` is NOT per module: it enumerates every non-system resource name in
 * the set, and stays OPEN for a forwarded manifest (see `readModuleGlobals` for
 * why a name list cannot be carried across the boundary honestly).
 */
export function buildKernelGlobalsIndex(
  manifests: ResourceManifest[],
  /** Every resource a CEL read can name, including scope-declared ones (see
   *  `buildObservedStateIndex`). Kinds that declare a `status:` get a typed,
   *  closed `status` node; every other resource node stays open, so no flat read
   *  that passes today can start failing. */
  resources?: ReadonlyMap<string, { kind: string; status?: Record<string, any> }>,
): KernelGlobalsIndex {
  const entryDoc =
    (manifests.find((m) => m.kind === "Telo.Application") as
      | Record<string, any>
      | undefined) ??
    (manifests.find((m) => m.kind === "Telo.Library") as
      | Record<string, any>
      | undefined);

  const entrySchema = globalsSchema(entryDoc, buildResourcesSchema(manifests, resources));
  const openResources = { type: "object", additionalProperties: true };
  const byModule = new Map<string, Record<string, any>>();

  return {
    forResource(m: ResourceManifest): Record<string, any> {
      const meta = m.metadata as { module?: string; moduleGlobals?: ModuleGlobals } | undefined;
      const stamped = meta?.moduleGlobals;
      if (!stamped) return entrySchema;
      const key = meta?.module ?? "";
      const cached = byModule.get(key);
      if (cached) return cached;
      const schema = globalsSchema(stamped, openResources);
      byModule.set(key, schema);
      return schema;
    },
  };
}

/** The blocks a declaring module contributes to its resources' CEL globals. */
interface ModuleGlobals {
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  ports?: Record<string, unknown>;
  module?: Record<string, unknown>;
}

function globalsSchema(
  doc: ModuleGlobals | Record<string, any> | undefined,
  resourcesSchema: Record<string, any>,
): Record<string, any> {
  return {
    type: "object",
    properties: {
      variables: buildSchemaMapSchema(doc?.variables as Record<string, any> | undefined),
      secrets: buildSchemaMapSchema(doc?.secrets as Record<string, any> | undefined),
      resources: resourcesSchema,
      ports: buildPortsSchema(doc?.ports as Record<string, any> | undefined),
      module: buildModuleSchema(doc),
    },
  };
}

/** The `module` namespace. Derived by `moduleMetadataSchema`, the same call the
 *  CEL environment types from, so the two cannot disagree about which fields
 *  exist or whether the namespace is closed. */
function buildModuleSchema(doc: ModuleGlobals | Record<string, any> | undefined): Record<string, any> {
  return (
    moduleMetadataSchema(
      ((doc as ModuleGlobals | undefined)?.module ?? (doc as any)?.metadata) as
        | Record<string, unknown>
        | undefined,
    ) ?? { type: "object", additionalProperties: true }
  );
}

/** Every non-system resource name in the set, plus the scope-declared ones. */
function buildResourcesSchema(
  manifests: ResourceManifest[],
  resources?: ReadonlyMap<string, { kind: string; status?: Record<string, any> }>,
): Record<string, any> {
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
  // Scope-declared resources (a `Run.Sequence`'s `with:`) publish like any other
  // now, so their names resolve too — inside the scope's regions, which is where
  // the only expressions that can name them live.
  for (const [key, entry] of resources ?? []) {
    if (key.includes(".")) continue;
    resourceProps[key] ??= { type: "object", additionalProperties: true };
    if (entry.status) applyObservedStateNode(resourceProps, key, entry.status);
  }
  // Imports' exported instances publish two levels deep (`resources.<Alias>.<name>`);
  // the alias node stays open so its other keys keep resolving.
  for (const [key, entry] of resources ?? []) {
    if (!key.includes(".") || !entry.status) continue;
    applyObservedStateNode(resourceProps, key, entry.status);
  }

  return { type: "object", properties: resourceProps, additionalProperties: false };
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
 * validation recognises `variables`, `secrets`, `resources`, `ports`
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
