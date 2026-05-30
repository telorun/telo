import type { AvailableKind, ParsedManifest, ParsedResource } from "./model";

/** The kernel built-ins `Telo.Application` / `Telo.Library` have no
 *  `Telo.Definition`, so the module root never appears in `viewData.kinds` or
 *  `manifest.resources` on its own. This adapter synthesizes both — an
 *  `AvailableKind` and a `ParsedResource`-shaped view of the module root — so
 *  selection, lookup, and the PickCanvas topology dispatch route the root
 *  through the exact same path as every other resource, rather than scattering
 *  "is it the root?" checks across the views. Applications and libraries share
 *  the same overview canvas; only the Application carries `targets`. */

export const APPLICATION_KIND_ID = "Telo.Application";
export const LIBRARY_KIND_ID = "Telo.Library";

/** Topology value that routes a module root to the overview graph canvas.
 *  Shared by both root kinds — the canvas is identical for either. */
export const MODULE_OVERVIEW_TOPOLOGY = "ModuleOverview";

/** True for a synthesized module-root kind (Application or Library). */
export function isModuleRootKind(kind: string): boolean {
  return kind === APPLICATION_KIND_ID || kind === LIBRARY_KIND_ID;
}

/** The synthesized kind id for a module manifest's root. */
function rootKindId(manifest: ParsedManifest): string {
  return manifest.kind === "Application" ? APPLICATION_KIND_ID : LIBRARY_KIND_ID;
}

const TYPE_PROPERTY = {
  type: "string",
  title: "type",
  enum: ["string", "integer", "number", "boolean", "object", "array"],
  description: "Value type.",
} as const;

const DESCRIPTION_PROPERTY = {
  type: "string",
  title: "description",
  description: "What this value is for.",
} as const;

/** Schema for one `variables:` / `secrets:` entry. The two module kinds have
 *  different contracts:
 *   - Application entries bind a host environment variable, so `env` is present
 *     and required (`env:` + `type:`).
 *   - Library entries are plain JSON-Schema declarations — the public contract
 *     an importer must satisfy. Libraries have no host-env access, so there is
 *     no `env` field and nothing is required.
 *  `default` and advanced JSON Schema keywords (`minimum`, `pattern`, …) are
 *  left to Source editing and preserved untouched through the form (the object
 *  editor only rewrites the properties it knows). Keeping them out of the form
 *  avoids a type-unsafe default editor (manifests must stay type safe). */
function bindingEntrySchema(isApplication: boolean): Record<string, unknown> {
  if (isApplication) {
    return {
      type: "object",
      required: ["env"],
      properties: {
        type: TYPE_PROPERTY,
        env: {
          type: "string",
          title: "env",
          description: "Host environment variable to bind.",
        },
        description: DESCRIPTION_PROPERTY,
      },
    };
  }
  return {
    type: "object",
    properties: {
      type: TYPE_PROPERTY,
      description: DESCRIPTION_PROPERTY,
    },
  };
}

/** A name-keyed map of `variables:` / `secrets:` entries. The
 *  `additionalProperties` entry schema routes each value through the form's
 *  object editor; `propertyNames` validates the binding name. */
function bindingMapSchema(
  title: string,
  description: string,
  isApplication: boolean,
): Record<string, unknown> {
  return {
    type: "object",
    title,
    description,
    additionalProperties: bindingEntrySchema(isApplication),
    propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
  };
}

function variablesSchema(isApplication: boolean): Record<string, unknown> {
  return bindingMapSchema(
    "Variables",
    isApplication ? "Env-bound variables." : "Variables importers must supply.",
    isApplication,
  );
}

function secretsSchema(isApplication: boolean): Record<string, unknown> {
  return bindingMapSchema(
    "Secrets",
    isApplication
      ? "Env-bound secrets, redacted in logs."
      : "Secrets importers must supply.",
    isApplication,
  );
}

/** Schema over the root's editable surface — used to satisfy the topology
 *  dispatch's `schema` guard. The graph canvas reads resources directly, not
 *  this. `targets` / `ports` are Application-only. */
function rootSchema(isApplication: boolean): Record<string, unknown> {
  return {
    type: "object",
    "x-telo-topology": MODULE_OVERVIEW_TOPOLOGY,
    properties: {
      ...(isApplication
        ? { targets: { type: "array", items: { type: "string" }, description: "Resources run on boot." } }
        : {}),
      variables: variablesSchema(isApplication),
      secrets: secretsSchema(isApplication),
      ...(isApplication ? { ports: { type: "object", description: "Declared inbound ports." } } : {}),
    },
  };
}

/** Schema for the detail-panel form when a module root is selected. Exposes
 *  only `variables` / `secrets` as editable maps — `targets` is edited on the
 *  canvas as edges, `ports` in the deployment view. Branches on kind because
 *  Application entries are env bindings while Library entries are plain
 *  JSON-Schema declarations (see `bindingEntrySchema`). */
export function moduleRootFormSchema(isApplication: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      variables: variablesSchema(isApplication),
      secrets: secretsSchema(isApplication),
    },
  };
}

/** The synthesized `AvailableKind` for a module root (Application or Library). */
export function moduleRootKind(manifest: ParsedManifest): AvailableKind {
  const isApplication = manifest.kind === "Application";
  const kindId = rootKindId(manifest);
  return {
    fullKind: kindId,
    alias: "Telo",
    kindName: isApplication ? "Application" : "Library",
    capability: kindId,
    topology: MODULE_OVERVIEW_TOPOLOGY,
    schema: rootSchema(isApplication),
  };
}

/** A `ParsedResource`-shaped projection of the module root, keyed by the module
 *  name. `fields` mirrors the root's editable blocks; `variables` / `secrets`
 *  are shared by both kinds, while `targets` / `ports` are Application-only. */
export function moduleRootResource(manifest: ParsedManifest): ParsedResource {
  const fields: Record<string, unknown> = { metadata: manifest.metadata };
  if (manifest.variables) fields.variables = manifest.variables;
  if (manifest.secrets) fields.secrets = manifest.secrets;
  if (manifest.kind === "Application") {
    fields.targets = manifest.targets;
    if (manifest.ports) fields.ports = manifest.ports;
  }
  return { kind: rootKindId(manifest), name: manifest.metadata.name, fields };
}
