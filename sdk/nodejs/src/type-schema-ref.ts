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
