import { isCompiledValue } from "@telorun/sdk";

/** Returns a schema-appropriate placeholder value for a CompiledValue field. */
function placeholderForSchema(schema: Record<string, unknown>): unknown {
  if (schema.default !== undefined) return schema.default;
  // An enum-constrained field needs a placeholder drawn from the enum: the
  // type-based fallbacks below satisfy `type` but violate `enum`, so any CEL
  // expression feeding an enum field would fail validation against a value the
  // author never wrote. Mirrors `celPlaceholderForSchema` in the analyzer, which
  // performs the same substitution for the static half.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case "integer":
    case "number":
      return (schema.minimum as number | undefined) ?? 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
}

/** Resolve a `$ref` (only `#/$defs/...` form) against the root schema. */
function resolveSchemaRef(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, unknown> {
  if (
    schema.$ref &&
    typeof schema.$ref === "string" &&
    (schema.$ref as string).startsWith("#/$defs/")
  ) {
    const defName = (schema.$ref as string).slice("#/$defs/".length);
    const defs = root.$defs as Record<string, Record<string, unknown>> | undefined;
    const resolved = defs?.[defName];
    if (resolved) return resolved;
  }
  return schema;
}

/** Collect property schemas from top-level `properties` and all `oneOf`/`anyOf` sub-schemas. */
function collectSchemaProperties(
  schema: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const props: Record<string, Record<string, unknown>> = {
    ...((schema.properties ?? {}) as Record<string, Record<string, unknown>>),
  };
  for (const sub of (schema.oneOf ?? schema.anyOf ?? []) as Record<string, unknown>[]) {
    if (sub && typeof sub === "object" && sub.properties) {
      for (const [k, v] of Object.entries(
        sub.properties as Record<string, Record<string, unknown>>,
      )) {
        if (!(k in props)) props[k] = v;
      }
    }
  }
  return props;
}

/** Replaces CompiledValue wrappers with schema-appropriate placeholders for schema validation.
 *  Template strings were compiled from YAML at load time; this restores a shape
 *  that AJV can validate without evaluating expressions. When no schema is
 *  supplied every compiled value collapses to `""` (the `default` branch of
 *  `placeholderForSchema`), matching the schema-unaware strip. */
export function stripCompiledValues(
  v: unknown,
  schema: Record<string, unknown> = {},
  rootSchema?: Record<string, unknown>,
): unknown {
  const root = rootSchema ?? schema;
  const resolved = resolveSchemaRef(schema, root);

  if (isCompiledValue(v)) return placeholderForSchema(resolved);
  if (Array.isArray(v)) {
    const itemSchema = resolveSchemaRef((resolved.items ?? {}) as Record<string, unknown>, root);
    return v.map((item) => stripCompiledValues(item, itemSchema, root));
  }
  if (v !== null && typeof v === "object") {
    const props = collectSchemaProperties(resolved);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = stripCompiledValues(val, props[k] ?? {}, root);
    }
    return out;
  }
  return v;
}
