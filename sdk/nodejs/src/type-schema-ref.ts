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

/** The canonical, alias-resolved `$id` a named type schema is registered under. */
export function canonicalTypeSchemaId(moduleName: string, typeName: string): string {
  return `${TELO_TYPE_SCHEME}${moduleName}/${typeName}`;
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
