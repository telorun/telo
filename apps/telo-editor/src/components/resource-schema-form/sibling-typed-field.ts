import type { JsonSchemaProperty } from "./types";

/**
 * A field whose JSON type is DECLARED BY A SIBLING, resolved against the object
 * being edited rather than fixed when the schema was built.
 *
 * The case this exists for is a `variables:` / `secrets:` entry, where `default`
 * holds a value of whatever `type:` says. A single untyped input there would
 * write `"8080"` into an entry declared `integer` — manifests must stay type
 * safe, which is why `default` had no field at all rather than a wrong one.
 *
 * Resolved at RENDER time, from the values the form already holds, so changing
 * the sibling changes the widget immediately. The alternative — baking the type
 * in when the schema is built — is stale by construction here: a `Selection`
 * carries its schema as data, frozen when it was issued, so the entry would go
 * on offering the previous type's widget until it was reselected.
 *
 * Deliberately NOT spelled `x-telo-*`. That vocabulary belongs to the analyzer
 * and is what a MANIFEST may say; this is a directive from the editor to its own
 * form, on a schema the editor synthesizes and nothing else ever reads.
 */
export const SIBLING_TYPE_KEY = "x-editor-type-from";

export interface SiblingTypeAnnotation {
  /** Name of the sibling property holding this field's JSON type. */
  field: string;
  /**
   * The types this field can actually be edited as. A declared type outside the
   * set HIDES the field rather than rendering it.
   *
   * Hiding is the point, not a shortcut: with no `properties` and no value
   * schema, an `object` falls through to the form's JSON-SCHEMA editor, which
   * writes a schema declaration where a value belongs. A field the form cannot
   * honestly edit is left to Source, where the object editor preserves it
   * untouched — the same posture the entry schema took toward `default` before
   * any of it was editable.
   */
  only?: string[];
}

function readAnnotation(prop: JsonSchemaProperty): SiblingTypeAnnotation | null {
  const raw = prop[SIBLING_TYPE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { field, only } = raw as Record<string, unknown>;
  if (typeof field !== "string" || !field) return null;
  return {
    field,
    ...(Array.isArray(only) ? { only: only.filter((t): t is string => typeof t === "string") } : {}),
  };
}

/**
 * The property as it should be rendered against `siblings`, or `null` when the
 * field must not be rendered at all.
 *
 * A property carrying no annotation is returned unchanged, so every caller can
 * route every field through this without asking first.
 */
export function resolveSiblingTypedProp(
  prop: JsonSchemaProperty,
  siblings: Record<string, unknown> | undefined,
): JsonSchemaProperty | null {
  const annotation = readAnnotation(prop);
  if (!annotation) return prop;
  const declared = siblings?.[annotation.field];
  // Nothing declared yet — there is no type to render this as, and guessing one
  // is exactly the unsafe write the annotation exists to prevent.
  if (typeof declared !== "string") return null;
  if (annotation.only && !annotation.only.includes(declared)) return null;
  return { ...prop, type: declared };
}
