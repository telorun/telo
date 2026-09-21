/**
 * The single reader of `x-telo-value-schema-from`: which value slots of a kind
 * name a type field, and the values a manifest holds at each.
 *
 * Read forward by the value-schema check and the kernel's literal decoding
 * (`derived-slots.ts`), and in reverse by the contract an undeclared type field
 * implies (`value-derived-contract.ts`). One walk, so the two directions cannot
 * disagree about which slots the annotation marks.
 */

const VALUE_SCHEMA_ANNOTATION = "x-telo-value-schema-from";

/** One annotated slot: its scope (`$.outputs`, `$.rows[*].value`) and the
 *  resource field naming the type its value must satisfy. */
export interface ValueSchemaSlot {
  readonly scope: string;
  readonly from: string;
}

/** Every `x-telo-value-schema-from` slot a kind's schema declares. */
export function valueSchemaSlots(schema: Record<string, any>, path = "$"): ValueSchemaSlot[] {
  if (!schema || typeof schema !== "object") return [];
  const out: ValueSchemaSlot[] = [];
  const from = schema[VALUE_SCHEMA_ANNOTATION];
  if (typeof from === "string" && from.length > 0) out.push({ scope: path, from });
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      out.push(...valueSchemaSlots(value, `${path}.${key}`));
    }
  }
  if (schema.items && typeof schema.items === "object") {
    out.push(...valueSchemaSlots(schema.items, `${path}[*]`));
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) out.push(...valueSchemaSlots(sub, path));
    }
  }
  return out;
}

/** Whether a slot's scope names one value per resource — no `[*]` segment. */
export function isSingleValueScope(scope: string): boolean {
  return !scope.includes("[*]");
}

/** Expand a `$.a[*].b` scope into the concrete values present, each with its path. */
export function resolveScopeValues(
  manifest: Record<string, any>,
  scope: string,
): Array<{ path: string; value: unknown }> {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  if (!stripped) return [];
  let frontier: Array<{ path: string; value: unknown }> = [{ path: "", value: manifest }];
  for (const segment of stripped.split(".")) {
    const wildcard = segment.endsWith("[*]");
    const name = wildcard ? segment.slice(0, -3) : segment;
    const next: Array<{ path: string; value: unknown }> = [];
    for (const entry of frontier) {
      const container = entry.value as Record<string, unknown> | undefined;
      if (!container || typeof container !== "object") continue;
      const child = container[name];
      if (child === undefined) continue;
      const childPath = entry.path ? `${entry.path}.${name}` : name;
      if (!wildcard) {
        next.push({ path: childPath, value: child });
        continue;
      }
      if (!Array.isArray(child)) continue;
      child.forEach((item, i) => next.push({ path: `${childPath}[${i}]`, value: item }));
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return frontier;
}
