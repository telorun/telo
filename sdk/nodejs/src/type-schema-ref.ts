/**
 * Module-scoped schema references for JSON Schema `$ref`.
 *
 * A `Type.JsonSchema` (or any `Telo.Type`) resource registers its schema under a
 * canonical URI `$id` of `telo://<module>/<typeName>`, so other schemas can
 * reference it with a standard JSON Schema `$ref`. Authors write the reference
 * through an import — `telo://Self/<typeName>` for the declaring module's own
 * type, or `telo://<Alias>/<typeName>` for an imported module's type — and the
 * loader rewrites the authority (`Self` / alias) to the resolved module name.
 * The version is carried by the `imports:` entry, never by the URI: only the
 * pinned version is ever loaded, so the canonical id stays version-free.
 */

export const TELO_TYPE_SCHEME = "telo://";

/**
 * The canonical, alias-resolved id a named type schema is registered under.
 *
 * Authority-free (`telo:<module>/<type>`, not `telo://<module>/<type>`) because
 * a JSON Schema validator has to RESOLVE it: AJV parses a `$ref` as a
 * URI-reference against the document base, and a non-standard scheme carrying an
 * authority resolves to nothing — a schema registered under `telo://M/T` cannot
 * be referenced by `$ref: "telo://M/T"` no matter how it is registered, while the
 * authority-free form resolves natively. Nothing enforced this before because no
 * runtime path ever compiled a `$ref`-bearing contract; the invocation contract
 * does, on every declaring kind.
 *
 * This is the INTERNAL id only. Authors keep writing the readable authority form
 * (`telo://Self/<type>`, `telo://<Alias>/<type>`) — see {@link parseTeloTypeRef} —
 * and the loader rewrites it to this. Published manifests are unaffected.
 */
export function canonicalTypeSchemaId(moduleName: string, typeName: string): string {
  return `telo:${moduleName}/${typeName}`;
}

/** The inverse of {@link canonicalTypeSchemaId}. Returns null for any other
 *  string, including the authoring authority form and fragment-bearing built-ins.
 *
 *  A resolver reads a named shape through this rather than by bare name: the
 *  canonical id carries the OWNING MODULE, so two libraries declaring a shape of
 *  the same name stay distinct. Resolving by name alone was how an alias got
 *  silently dropped. */
export function parseCanonicalTypeSchemaId(
  ref: unknown,
): { moduleName: string; typeName: string } | null {
  if (typeof ref !== "string") return null;
  const match = /^telo:([^/#:]+)\/([^#/]+)$/.exec(ref);
  if (!match) return null;
  return { moduleName: match[1]!, typeName: match[2]! };
}

/** Top-level keywords merged structurally rather than copied wholesale when
 *  resolving `extends`: object shape (`properties` / `required` /
 *  `additionalProperties`) is deep-merged, and composition keywords (`allOf` /
 *  `oneOf` / `anyOf`) are preserved as intersected `allOf` branches. Everything
 *  else (`type`, `title`, `description`, …) is carried over with the more-derived
 *  schema winning. */
const STRUCTURAL_KEYS = new Set([
  "properties",
  "required",
  "additionalProperties",
  // `$defs` is a NAMESPACE, not a value: last-wins would drop every definition
  // the other side declared, and a `$ref` pointing at one would then resolve to
  // nothing. That is not hypothetical — a schema-valued slot is localized to
  // `#/$defs/telo:<Fragment>` and hoisted here, so a child declaring any `$defs`
  // of its own would erase the parent's hoisted entry and leave the parent's
  // slots pointing at a definition that no longer exists.
  "$defs",
  "definitions",
  "allOf",
  "oneOf",
  "anyOf",
]);

/**
 * Resolve `extends` into a single self-contained object schema by deep-merging an
 * ordered list of already-resolved schemas (parents first, the own schema last):
 *
 * - `properties` — union; the more-derived (later) schema wins on a key conflict.
 * - `required` — union across all levels.
 * - `additionalProperties` — the most-derived schema that sets it.
 * - `allOf` / `oneOf` / `anyOf` — **preserved, never dropped**: every schema's
 *   composition keywords are collected into the result's `allOf` (each `oneOf` /
 *   `anyOf` wrapped as its own branch), which intersects them — a value must
 *   satisfy the merged object shape AND every inherited/own composition
 *   constraint. A plain object-inheritance schema declares none of these, so the
 *   result carries no `allOf` and stays free of the `allOf` +
 *   `additionalProperties: false` footgun.
 * - everything else — carried over, more-derived wins.
 *
 * Assumes object schemas (`type` defaults to `"object"` when unset). The result
 * carries no `$ref`s, so it is directly usable as a validation schema.
 *
 * Single source of truth for `Type.JsonSchema` inheritance: the runtime `type`
 * controller and the analyzer both call this, so static analysis and runtime
 * validation can never disagree on a type's effective shape.
 */
export function mergeTypeSchemas(
  schemas: Record<string, unknown>[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const defs: Record<string, Record<string, unknown>> = { $defs: {}, definitions: {} };
  const required = new Set<string>();
  let additionalProperties: unknown;
  let hasAdditionalProperties = false;
  // Inherited/own `allOf` / `oneOf` / `anyOf`, intersected into the result's
  // `allOf` so no declared constraint is silently lost.
  const composition: unknown[] = [];

  for (const schema of schemas) {
    if (!schema || typeof schema !== "object") continue;
    for (const [key, value] of Object.entries(schema)) {
      if (!STRUCTURAL_KEYS.has(key)) out[key] = value;
    }
    const props = (schema as { properties?: unknown }).properties;
    if (props && typeof props === "object") Object.assign(properties, props);
    for (const key of ["$defs", "definitions"] as const) {
      const declared = (schema as Record<string, unknown>)[key];
      if (declared && typeof declared === "object") Object.assign(defs[key], declared);
    }
    const req = (schema as { required?: unknown }).required;
    if (Array.isArray(req)) for (const name of req) required.add(name as string);
    if ("additionalProperties" in schema) {
      additionalProperties = (schema as { additionalProperties?: unknown }).additionalProperties;
      hasAdditionalProperties = true;
    }
    const allOf = (schema as { allOf?: unknown }).allOf;
    if (Array.isArray(allOf)) composition.push(...allOf);
    const oneOf = (schema as { oneOf?: unknown }).oneOf;
    if (Array.isArray(oneOf)) composition.push({ oneOf });
    const anyOf = (schema as { anyOf?: unknown }).anyOf;
    if (Array.isArray(anyOf)) composition.push({ anyOf });
  }

  if (Object.keys(properties).length > 0) out.properties = properties;
  for (const key of ["$defs", "definitions"] as const) {
    if (Object.keys(defs[key]).length > 0) out[key] = defs[key];
  }
  if (required.size > 0) out.required = [...required];
  if (hasAdditionalProperties) out.additionalProperties = additionalProperties;
  if (composition.length > 0) out.allOf = composition;
  if (out.type === undefined) out.type = "object";
  return out;
}

/** Parsed parts of a `telo://<authority>/<typeName>` schema reference. */
export interface TeloTypeRef {
  authority: string;
  typeName: string;
}

/**
 * Parse a `telo://<authority>/<typeName>` schema `$ref`. Returns null for any
 * other string — notably fragment-bearing built-ins like
 * `telo://manifest#/$defs/ResourceRef`, which carry no `authority/type` path and
 * must be left untouched.
 */
export function parseTeloTypeRef(ref: unknown): TeloTypeRef | null {
  if (typeof ref !== "string") return null;
  const match = /^telo:\/\/([^/#]+)\/([^#/]+)$/.exec(ref);
  if (!match) return null;
  return { authority: match[1], typeName: match[2] };
}
