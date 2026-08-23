import type {
  AvailableKind,
  ImportedModuleConfig,
  ParsedImport,
  ParsedManifest,
  ParsedResource,
} from "./model";
import { SIBLING_TYPE_KEY } from "./components/resource-schema-form/sibling-typed-field";

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
 *  Advanced JSON Schema keywords (`minimum`, `pattern`, …) are left to Source
 *  editing and preserved untouched through the form — the object editor only
 *  rewrites the properties it knows.
 *
 *  `default` is typed by the entry's own `type:` rather than fixed here, so the
 *  form writes `8080` into an `integer` entry and `"8080"` into a `string` one.
 *  A single untyped input would write whichever the widget happened to produce,
 *  which is why the field had no editor at all before there was a way to type
 *  it; see `sibling-typed-field.ts`. */
export function bindingEntrySchema(isApplication: boolean): Record<string, unknown> {
  return {
    type: "object",
    ...(isApplication ? { required: ["env"] } : {}),
    properties: {
      type: TYPE_PROPERTY,
      // Applications bind a host env var; a Library entry is a plain
      // JSON-Schema declaration and has no host-env access at all.
      ...(isApplication
        ? {
            env: {
              type: "string",
              title: "env",
              description: "Host environment variable to bind.",
            },
          }
        : {}),
      default: defaultValueProperty(
        isApplication
          ? "Value used when the environment variable is unset."
          : "Value used when an importer supplies none.",
      ),
      description: DESCRIPTION_PROPERTY,
    },
  };
}

/** The `default:` slot of a declaration whose own `type:` says what it holds.
 *
 *  `object` and `array` are absent from `only`, so an entry declaring one shows
 *  no `default` field. That is deliberate: the form has no editor for an
 *  arbitrary JSON value — an untyped object slot falls through to its
 *  JSON-SCHEMA editor, which would write a schema declaration where a value
 *  belongs — and a field it cannot honestly edit is better left to Source, which
 *  preserves it untouched, than rendered as the wrong thing. */
function defaultValueProperty(description: string): Record<string, unknown> {
  return {
    title: "default",
    description,
    [SIBLING_TYPE_KEY]: { field: "type", only: ["string", "integer", "number", "boolean"] },
  };
}

/** One `ports:` entry. Application-only, and implicitly a port integer — the
 *  kernel takes the number from the bound env var, so there is no `type:` to
 *  declare. The deployment view edits the VALUE a port resolves to; this is the
 *  binding itself, which had no editor at all before the module bar. */
export function portEntrySchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["env"],
    properties: {
      env: {
        type: "string",
        title: "env",
        description: "Host environment variable carrying the port number.",
      },
      protocol: {
        type: "string",
        title: "protocol",
        description: "Transport protocol. Defaults to tcp.",
        enum: ["tcp", "udp"],
      },
      default: {
        type: "integer",
        title: "default",
        description: "Port used when the env var is unset.",
        minimum: 1,
        maximum: 65535,
      },
      description: DESCRIPTION_PROPERTY,
    },
  };
}

/** One inline `imports:` entry, as the detail panel edits it.
 *
 *  `source` and `integrity` are shown but not editable. Repointing an import has
 *  to re-resolve the target's sub-graph and rewire the import edges — that is
 *  `upgradeImportViaAst` and the Imports view's upgrade flow, which know how;
 *  a plain field write rewrites the YAML and stops there, leaving the workspace
 *  holding the old module's kinds and every `!ref` into it dangling, with
 *  nothing to say why. `readOnly` is draft-07's own keyword and `ScalarField`
 *  already honours it, so this is a declaration rather than a special case.
 *
 *  Keys the form does not declare are preserved untouched on commit, so an
 *  entry's `runtime` survives editing its values.
 *
 *  `declared` absent means the workspace could not read the library — NOT that
 *  the library accepts nothing. See {@link importValuesSchema}. */
export function importEntrySchema(
  imp: ParsedImport,
  declared?: ImportedModuleConfig,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    source: {
      type: "string",
      title: "source",
      description:
        "Where the library is loaded from. Change it with Upgrade in the Imports view — repointing an import has to re-resolve its sub-graph.",
      readOnly: true,
    },
    // Offered only where the entry wrote its pin as an `integrity:` sibling. A
    // local import never carries one and a fragment pin lives inside `source`,
    // so declaring it unconditionally would show most imports a dead field.
    ...(imp.integrity
      ? {
          integrity: {
            type: "string",
            title: "integrity",
            description:
              "Pin on the version this import resolves to. Written by install and upgrade.",
            readOnly: true,
          },
        }
      : {}),
  };
  const variables = importValuesSchema(
    "variables",
    "Values passed into the imported library.",
    declared,
    declared?.variables,
  );
  if (variables) properties.variables = variables;
  const secrets = importValuesSchema(
    "secrets",
    "Secrets passed into the imported library.",
    declared,
    declared?.secrets,
  );
  if (secrets) properties.secrets = secrets;
  return { type: "object", properties };
}

/** The schema for one import's `variables:` / `secrets:` VALUES, or `undefined`
 *  when the block should not be offered at all.
 *
 *  A library's own `variables:` block is a JSON-Schema property map — the
 *  contract an importer must satisfy — so it IS the schema for what the importer
 *  writes here: one property per name the library accepts, carrying its type,
 *  description and default. Deriving it needs nothing from the library beyond
 *  what it already declares, and it makes the property set CLOSED, which is the
 *  point: a name the library never declared is passed to nothing, so offering to
 *  add one would be offering to write a line the kernel has no use for.
 *
 *  That is also why "declares none" returns nothing rather than an open map. The
 *  two cases only look alike:
 *   - contract read, empty → the library accepts none. There is nothing to set,
 *     and an "add entry" affordance here would invent names.
 *   - contract unread (an import the workspace could not resolve) → we do not
 *     know what it accepts. An open name→string map is the honest shape and it
 *     keeps an unreachable import's values editable. A string is what a value
 *     written as a literal or a CEL expression already is; anything else is
 *     edited in Source. What this must NOT return is an open OBJECT: with no
 *     `properties` and no value schema the form falls through to its JSON-Schema
 *     editor, which writes a schema DECLARATION where a value belongs.
 */
function importValuesSchema(
  title: string,
  description: string,
  declared: ImportedModuleConfig | undefined,
  contract: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!declared) {
    return { type: "object", title, description, additionalProperties: { type: "string" } };
  }
  if (!contract || Object.keys(contract).length === 0) return undefined;
  return { type: "object", title, description, properties: contract };
}

/** A Library's `exports:` block. `kinds` and `resources` are name lists — a
 *  bare local name, or `<Alias>.<Name>` to re-export. `code` is left opaque: it
 *  is delivery metadata, not part of the surface this view edits. */
function exportsSchema(): Record<string, unknown> {
  return {
    type: "object",
    title: "Exports",
    description: "The kinds and instances importers may reference.",
    properties: {
      kinds: {
        type: "array",
        title: "Kinds",
        description: "Kinds importers may declare (`<Alias>.<Name>` re-exports).",
        items: { type: "string" },
      },
      resources: {
        type: "array",
        title: "Resources",
        description: "Instances importers may `!ref` (`<Alias>.<name>` re-exports).",
        items: { type: "string" },
      },
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
      ...(isApplication
        ? {
            ports: {
              type: "object",
              title: "Ports",
              description: "Declared inbound ports.",
              additionalProperties: portEntrySchema(),
              propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
            },
          }
        : { exports: exportsSchema() }),
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
    categories: [],
  };
}

/** A `ParsedResource`-shaped projection of the module root, keyed by the module
 *  name. `fields` mirrors the root's editable blocks; `variables` / `secrets`
 *  are shared by both kinds, while `targets` / `ports` are Application-only and
 *  `exports` is the Library's counterpart to them. */
export function moduleRootResource(manifest: ParsedManifest): ParsedResource {
  const fields: Record<string, unknown> = { metadata: manifest.metadata };
  const imports = inlineImportEntries(manifest);
  if (imports) fields.imports = imports;
  if (manifest.variables) fields.variables = manifest.variables;
  if (manifest.secrets) fields.secrets = manifest.secrets;
  if (manifest.kind === "Application") {
    fields.targets = manifest.targets;
    if (manifest.ports) fields.ports = manifest.ports;
  } else if (manifest.exports) {
    fields.exports = manifest.exports;
  }
  return { kind: rootKindId(manifest), name: manifest.metadata.name, fields };
}

/** The module doc's inline `imports:` map, projected back from `ParsedImport`.
 *
 *  Only the INLINE half: an import authored as its own `Telo.Import` document
 *  lives outside the module doc, so a write routed through the root's fields
 *  would create a second entry under the same alias — a `DUPLICATE_IMPORT_ALIAS`
 *  rather than an edit. Its absence here is what makes that unrepresentable.
 *
 *  The projection only has to be self-consistent, never byte-faithful to the
 *  AST: a form commits against these same values, so an entry nobody edited
 *  diffs to nothing and its authored shape is never rewritten. */
function inlineImportEntries(manifest: ParsedManifest): Record<string, unknown> | undefined {
  const entries = manifest.imports.filter((imp) => imp.inline);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map((imp) => [
      imp.name,
      {
        source: imp.source,
        ...(imp.integrity ? { integrity: imp.integrity } : {}),
        ...(imp.variables ? { variables: imp.variables } : {}),
        ...(imp.secrets ? { secrets: imp.secrets } : {}),
      },
    ]),
  );
}
