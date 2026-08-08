/**
 * Resolve a type field (`inputType` / `outputType`, or any `telo#Type` slot) to
 * the JSON Schema behind it.
 *
 * Extracted from `ResourceContextImpl` so the build-time validator warm
 * (`precompileDefinitionSchemas`) resolves a contract through the SAME code the
 * runtime binding does. It used to compile the raw declaration instead —
 * `{kind: Telo.JsonSchema, schema: {...}}`, which is not a JSON Schema at all,
 * so `SchemaValidator.compile` read it as a property map and baked a validator
 * for `{kind, schema}` that no dispatch would ever ask for. One resolver, one
 * cache key.
 *
 * `getSchema` is the registry lookup — `SchemaValidator.getSchema` at both call
 * sites. At warm time named types are not registered yet, so a bare-name
 * declaration resolves to `undefined` and the caller simply skips it.
 */
export type SchemaLookup = (name: string) => object | undefined;

/** The four declaration forms: a registered type's name, a `{kind, name}` ref
 *  object, an inline `{kind, schema}` type resource, and a raw JSON Schema. */
function readTypeSchema(
  typeRef: unknown,
  getSchema: SchemaLookup,
): Record<string, any> | undefined {
  if (!typeRef) return undefined;
  if (typeof typeRef === "string") return getSchema(typeRef) as Record<string, any> | undefined;
  if (typeof typeRef !== "object") return undefined;
  const ref = typeRef as Record<string, any>;
  if (ref.schema && typeof ref.schema === "object") return ref.schema;
  if (typeof ref.name === "string") return getSchema(ref.name) as Record<string, any> | undefined;
  if (ref.type || ref.properties || ref.$ref) return ref;
  return undefined;
}

/**
 * Follow a schema that is nothing but a `$ref` to a registered type, so the
 * schema-level questions (which properties are streams, which paths carry a
 * default) are asked of the real shape rather than of an alias.
 *
 * Only the whole-document alias form is followed, and only to READ it — the
 * schema handed to AJV keeps its `$ref`s intact, because AJV resolves them
 * itself against the registered ids and each type stays its own document with
 * its own `$defs`. Inlining instead would move a `$ref: "#/$defs/X"` out of the
 * document that defines `$defs.X`.
 *
 * `seen` guards a cycle two mutually-referencing types would otherwise spin on.
 * A `$ref` alongside other keywords is left alone: that is a composition, not
 * an alias.
 */
function followTypeAlias(
  schema: Record<string, any> | undefined,
  getSchema: SchemaLookup,
): Record<string, any> | undefined {
  const seen = new Set<string>();
  let current = schema;
  while (
    current &&
    typeof current.$ref === "string" &&
    Object.keys(current).length === 1 &&
    !seen.has(current.$ref)
  ) {
    seen.add(current.$ref);
    const target = getSchema(current.$ref) as Record<string, any> | undefined;
    if (!target) return current;
    current = target;
  }
  return current;
}

/** The JSON Schema a type field names, or `undefined` when it resolves to
 *  nothing (an unregistered name, a declaration in none of the four forms). */
export function resolveTypeFieldSchema(
  typeRef: unknown,
  getSchema: SchemaLookup,
): Record<string, any> | undefined {
  return followTypeAlias(readTypeSchema(typeRef, getSchema), getSchema);
}
