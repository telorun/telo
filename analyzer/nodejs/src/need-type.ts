import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { sensitiveMembersOf, valueTypeOf } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { liftFragmentDefs } from "./manifest-schemas.js";
import { memberForbidden, membersSlotOf } from "./members-value-slot.js";
import { refSentinelTarget, type RefSentinelTarget } from "./ref-sentinel-target.js";
import { INJECTED } from "./resource-input.js";

/**
 * Need types and needs — THE single reader of `kind: Telo.NeedType` documents,
 * of a module's `needs:` block and of an import's `needs:` supply, in both
 * halves (the analyzer's passes, the kernel's need-type controller and import
 * controller), on the `resource-input.ts` precedent.
 *
 * A `Telo.NeedType` document registers a kind `<Module>.<Name>` whose
 * capability is `Telo.Provider` and whose controller is the kernel's one
 * need-type controller: a resource of it is a FULFILMENT, and its published
 * reading is exactly its `fields`. The kind is synthesized here
 * ({@link needTypeDefinition}) and read through `kindDeclarationOf`, so the
 * analyzer and the kernel register the same definition from the same document.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

export const NEED_TYPE_KIND = "Telo.NeedType";

/** The kernel controller entry every need-type kind names. */
export const NEED_TYPE_CONTROLLER_ENTRY = "Telo.NeedType";

/** What a need type declares: the fields a fulfilment hands over, which of
 *  them are required, and the schema of the parameters a need may state. */
export interface NeedTypeShape {
  fields: Record<string, Record<string, unknown>>;
  required: string[];
  parameters?: Record<string, unknown>;
  /** `semver` when fulfilments are versioned — what lets a need state a range. */
  version?: "semver";
  /** The closed list of feature names a need may ask for. */
  features?: string[];
  /** `root` when a need of the type is fulfilled only through a root need,
   *  forwarded whole — never a self-supplied fulfilment, a field-by-field supply
   *  at an import, or a library need reaching the root unforwarded. */
  supply?: "root";
}

/** The marker the synthesized definition carries — read through
 *  {@link needTypeOf}, never by testing the field. */
const NEED_TYPE_MARKER = "needType";

export function isNeedTypeDoc(manifest: { kind?: unknown } | undefined): boolean {
  return manifest?.kind === NEED_TYPE_KIND;
}

/** Read a `Telo.NeedType` document's shape. Malformed parts read as absent;
 *  the built-in schema reports them against the precise path. */
export function readNeedTypeShape(doc: unknown): NeedTypeShape {
  const record = (doc ?? {}) as Record<string, unknown>;
  const fields: Record<string, Record<string, unknown>> = {};
  const rawFields = record.fields;
  if (rawFields && typeof rawFields === "object" && !Array.isArray(rawFields)) {
    for (const [name, schema] of Object.entries(rawFields as Record<string, unknown>)) {
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        fields[name] = schema as Record<string, unknown>;
      }
    }
  }
  const required = Array.isArray(record.required)
    ? (record.required as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
  const parameters =
    record.parameters && typeof record.parameters === "object" && !Array.isArray(record.parameters)
      ? (record.parameters as Record<string, unknown>)
      : undefined;
  const features = Array.isArray(record.features)
    ? (record.features as unknown[]).filter((f): f is string => typeof f === "string")
    : undefined;
  return {
    fields,
    required,
    ...(parameters ? { parameters } : {}),
    ...(record.version === "semver" ? { version: "semver" as const } : {}),
    ...(features ? { features } : {}),
    ...(record.supply === "root" ? { supply: "root" as const } : {}),
  };
}

/**
 * The kind a `Telo.NeedType` document registers — reached through
 * `kindDeclarationOf` (`kind-declaration.ts`), which memoizes it per document.
 *
 * Its author schema is the closed `fields:` map a self-supplied fulfilment
 * writes: the type's fields, its required fields, nothing else, and `fields`
 * itself required when the type requires one — so a schema-driven reader (a
 * form, completion, another kernel's create-time validation) offers and accepts
 * exactly what the need table does. The definition carries the document's
 * authored `metadata` whole.
 */
export function needTypeDefinition(doc: ResourceManifest): ResourceDefinition {
  const shape = readNeedTypeShape(doc);
  const required = shape.required.filter((name) => name in shape.fields);
  return {
    kind: "Telo.Definition",
    metadata: { ...(doc.metadata ?? {}) },
    capability: "Telo.Provider",
    controllers: [{ runtime: "kernel", entry: NEED_TYPE_CONTROLLER_ENTRY }],
    schema: liftFragmentDefs({
      type: "object",
      properties: {
        fields: {
          type: "object",
          properties: { ...shape.fields },
          ...(required.length > 0 ? { required } : {}),
          additionalProperties: false,
        },
      },
      ...(required.length > 0 ? { required: ["fields"] } : {}),
      additionalProperties: false,
    }),
    [NEED_TYPE_MARKER]: shape,
  } as unknown as ResourceDefinition;
}

/**
 * True when a schema finding on a fulfilment is one the need table reports —
 * an undeclared key under `fields` (`NEED_FIELD_UNDECLARED`) or a missing
 * required field, or a missing `fields` (`NEED_SLOT_MISMATCH`) — so the
 * analyzer reports each such fact once.
 */
export function needTableReportsFinding(issue: {
  keyword?: string;
  path: string;
  missingProperty?: string;
}): boolean {
  if (issue.keyword === "additionalProperties") return issue.path === "fields";
  if (issue.keyword === "required") {
    return issue.path === "fields" || issue.path === `fields.${issue.missingProperty}`;
  }
  return false;
}

/** The need type a definition registers, or undefined when it is not one. */
export function needTypeOf(def: ResourceDefinition | undefined): NeedTypeShape | undefined {
  const shape = (def as Record<string, unknown> | undefined)?.[NEED_TYPE_MARKER];
  return shape && typeof shape === "object" ? (shape as NeedTypeShape) : undefined;
}

/** What `resources.<name>` reads as for a fulfilment of `shape`: its fields,
 *  closed, and null as well when the need is optional. */
export function needReadingSchema(
  shape: NeedTypeShape,
  optional: boolean,
): Record<string, unknown> {
  const reading = liftFragmentDefs({
    type: "object",
    properties: { ...shape.fields },
    required: shape.required.filter((name) => name in shape.fields),
    additionalProperties: false,
  });
  return optional ? { ...reading, type: ["object", "null"] } : reading;
}

/** The field names whose values are sensitive — marked `x-telo-sensitive`. */
export function sensitiveNeedFields(shape: NeedTypeShape): string[] {
  return Object.entries(shape.fields)
    .filter(([, schema]) => schema["x-telo-sensitive"] === true || holdsSensitiveMembers(schema))
    .map(([name]) => name);
}

/** True when a field's value type declares a sensitive member (a URL's
 *  `password`) the field's slot does not forbid, which makes the field sensitive
 *  whenever its value holds one. */
export function holdsSensitiveMembers(schema: Record<string, unknown>): boolean {
  const entry = valueTypeOf(schema);
  if (entry === undefined) return false;
  const slot = membersSlotOf(schema);
  return sensitiveMembersOf(entry).some((member) => !slot || !memberForbidden(slot, member));
}

/** True when a field schema holds text, which is what substring redaction can
 *  honour: a string, or a value type whose plain encoding is its text. */
export function isTextFieldSchema(schema: Record<string, unknown>): boolean {
  const entry = valueTypeOf(schema);
  if (entry !== undefined) return entry.representation === "instance" && entry.encoding !== undefined;
  const type = schema.type;
  if (type === "string") return true;
  if (Array.isArray(type)) {
    return type.includes("string") && type.every((t) => t === "string" || t === "null");
  }
  return false;
}

/** One entry of a module's `needs:` block. */
export interface NeedDeclaration {
  /** The entry key — named inside the module exactly as a declared resource:
   *  `!ref <name>`, `resources.<name>.<field>`. */
  name: string;
  /** The alias-qualified need-type kind, as written in the declaring module. */
  kind: string;
  /** Literal parameters, checked against the type's `parameters` schema. */
  parameters?: unknown;
  /** The version range the need asks for, as written — the `requires:`
   *  comparator grammar, legal only on a versioned type. */
  version?: unknown;
  /** The features the need asks for, as written — a subset of the type's. */
  features?: unknown;
  optional: boolean;
  description?: string;
  /** Whether the entry writes `env:` at all — legal on an Application's need
   *  only (`LIBRARY_ENV_KEY_REJECTED`). */
  declaresEnv: boolean;
  /** The environment names an Application's need binds, by field. Malformed
   *  values are skipped — the document's own schema reports them. */
  env?: Record<string, string>;
}

/** Read a module document's `needs:` block. Malformed entries are skipped —
 *  the document's own schema reports them. */
export function readNeeds(moduleDoc: unknown): NeedDeclaration[] {
  const raw = (moduleDoc as { needs?: unknown } | undefined)?.needs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: NeedDeclaration[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.kind !== "string" || entry.kind.length === 0) continue;
    const env = readEnvBindings(entry.env);
    out.push({
      name,
      kind: entry.kind,
      ...(entry.parameters !== undefined ? { parameters: entry.parameters } : {}),
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.features !== undefined ? { features: entry.features } : {}),
      optional: entry.optional === true,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      declaresEnv: "env" in entry,
      ...(env ? { env } : {}),
    });
  }
  return out;
}

function readEnvBindings(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [field, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name === "string" && name.length > 0) out[field] = name;
  }
  return out;
}

/** The `needs:` map an import supplies, keyed by the target's need name. */
export function readSuppliedNeeds(importDoc: unknown): Record<string, unknown> {
  const raw = (importDoc as { needs?: unknown } | undefined)?.needs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/** How one supplied need is written: whole, by `!ref` to a need or a
 *  fulfilment of the importer; or field by field. */
export type NeedSupply =
  | { form: "whole"; target: RefSentinelTarget }
  | { form: "fields"; fields: Record<string, unknown> }
  | { form: "invalid" };

/** Read one supplied need. The `!ref` stays a sentinel — `needs:` is not a
 *  reference slot that `!ref` resolution rewrites — so a field map whose type
 *  declares fields named `kind` and `name` can never read as a reference. */
export function needSupplyOf(value: unknown): NeedSupply {
  if (isRefSentinel(value)) {
    const target = refSentinelTarget(value);
    return target ? { form: "whole", target } : { form: "invalid" };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { form: "fields", fields: value as Record<string, unknown> };
  }
  return { form: "invalid" };
}

/** Marker stamped on a synthesized need declaration. */
const INJECTED_NEED = "xTeloNeed";

/**
 * A kind-only declaration per `needs:` entry, in the declaring module's own
 * scope — the `injectedDeclarations` precedent of a library's `resources:`
 * inputs, and marked the same way, so every pass that already knows a stand-in
 * is not an instantiation treats it as one. It is what makes `!ref <need>`
 * resolve and `resources.<need>.<field>` type inside the module; the kernel's
 * import controller never creates it, binding the fulfilment under the name
 * instead.
 */
export function injectedNeedDeclarations(
  moduleDoc: ResourceManifest,
  ownModule: string | undefined,
): ResourceManifest[] {
  const needs = readNeeds(moduleDoc);
  if (needs.length === 0) return [];
  const meta = moduleDoc.metadata as { source?: string; sourceLine?: number } | undefined;
  return needs.map((need) => ({
    kind: need.kind,
    metadata: {
      name: need.name,
      ...(ownModule ? { module: ownModule } : {}),
      source: meta?.source ?? "",
      sourceLine: meta?.sourceLine ?? 0,
      [INJECTED]: true,
      [INJECTED_NEED]: { optional: need.optional },
    },
  })) as unknown as ResourceManifest[];
}

/** The need a synthesized declaration stands in for, or undefined when the
 *  manifest is not one. */
export function injectedNeedOf(
  manifest: ResourceManifest | undefined,
): { optional: boolean } | undefined {
  const marker = (manifest?.metadata as Record<string, unknown> | undefined)?.[INJECTED_NEED];
  return marker && typeof marker === "object" ? (marker as { optional: boolean }) : undefined;
}
