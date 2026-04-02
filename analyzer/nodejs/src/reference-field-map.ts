/** An entry for a field that carries one or more x-telo-ref constraints. */
export interface RefFieldEntry {
  /** One or more canonical ref strings ("namespace/module#TypeName" or "kernel#TypeName").
   *  Multiple entries arise from anyOf branches. */
  refs: string[];
  /** True when the field path traversed through at least one array (path contains "[]"). */
  isArray: boolean;
  /** x-telo-context schema declared on this ref slot, if any. Describes the CEL invocation
   *  context available to resources placed in this slot. */
  context?: Record<string, any>;
}

/** An entry for a field that declares an execution scope (x-telo-scope). */
export interface ScopeFieldEntry {
  /** JSON Pointer(s) (RFC 6901) declaring where x-telo-ref slots within this field can
   *  resolve to the scoped resources. */
  scope: string | string[];
}

/** An entry for a field whose schema is resolved dynamically from a referenced resource's
 *  definition schema (x-telo-schema-from). */
export interface SchemaFromFieldEntry {
  /** Full path expression as written in the schema, e.g.:
   *  - "backend/$defs/NodeOptions"   (relative: sibling x-telo-ref property)
   *  - "/backend/$defs/NodeOptions"  (absolute: root-level x-telo-ref property) */
  schemaFrom: string;
}

export type FieldMapEntry = RefFieldEntry | ScopeFieldEntry | SchemaFromFieldEntry;

/** Map from field path to its reference or scope metadata.
 *  Paths use dot notation; array traversal is denoted by `[]` (e.g. "steps[].invoke"). */
export type ReferenceFieldMap = Map<string, FieldMapEntry>;

export function isRefEntry(entry: FieldMapEntry): entry is RefFieldEntry {
  return "refs" in entry;
}

export function isScopeEntry(entry: FieldMapEntry): entry is ScopeFieldEntry {
  return "scope" in entry;
}

export function isSchemaFromEntry(entry: FieldMapEntry): entry is SchemaFromFieldEntry {
  return "schemaFrom" in entry;
}

/** Keys that a named reference object may have. Values beyond these indicate an inline resource. */
export const REFERENCE_KEYS = new Set(["kind", "name", "metadata"]);

/** True when `val` is an inline resource definition rather than a named reference.
 *  A named reference (has string `name`) may carry extra keys (e.g. `inputs`) that
 *  are runtime call parameters — those are never inline resources. */
export function isInlineResource(val: Record<string, unknown>): boolean {
  if (typeof val.name === "string") return false;
  return Object.keys(val).some((k) => !REFERENCE_KEYS.has(k));
}

/** Resolves all values at a field map path in a resource config.
 *  `[]` in a path segment means "iterate array at this key". */
export function resolveFieldValues(obj: unknown, path: string): unknown[] {
  const parts = path.split(".");
  let current: unknown[] = [obj];
  for (const part of parts) {
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const item of current) {
      if (!item || typeof item !== "object") continue;
      const val = (item as Record<string, unknown>)[key];
      if (val == null) continue;
      if (isArray && Array.isArray(val)) next.push(...val);
      else if (!isArray) next.push(val);
    }
    current = next;
  }
  return current;
}

/**
 * Traverses a definition's JSON Schema once and returns a field map recording every
 * x-telo-ref slot and every x-telo-scope slot.
 *
 * - A node with `x-telo-ref` → RefFieldEntry with refs: [that value]
 * - A node with `anyOf` whose branches have `x-telo-ref` → RefFieldEntry with all branch refs
 * - A node with `x-telo-scope` → ScopeFieldEntry
 * - A node with `type: array` + `items` → recurse into items with path "fieldName[]"
 * - A node with `properties` → recurse into each property
 */
export function buildReferenceFieldMap(schema: Record<string, any>): ReferenceFieldMap {
  const map: ReferenceFieldMap = new Map();
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      traverseNode(propSchema as Record<string, any>, key, map);
    }
  }
  return map;
}

function collectRefs(node: Record<string, any>): string[] {
  const refs: string[] = [];
  if (typeof node["x-telo-ref"] === "string") {
    refs.push(node["x-telo-ref"]);
  }
  if (Array.isArray(node.anyOf)) {
    for (const branch of node.anyOf) {
      if (branch && typeof branch["x-telo-ref"] === "string") {
        refs.push(branch["x-telo-ref"]);
      }
    }
  }
  return refs;
}

function traverseNode(node: Record<string, any>, path: string, map: ReferenceFieldMap): void {
  // Scope slot — record and stop; do not recurse into scope contents
  if ("x-telo-scope" in node) {
    map.set(path, { scope: node["x-telo-scope"] });
    return;
  }

  // Schema-from slot — record and stop; no further traversal needed
  if ("x-telo-schema-from" in node) {
    map.set(path, { schemaFrom: node["x-telo-schema-from"] });
    return;
  }

  // Reference slot (direct or via anyOf)
  const refs = collectRefs(node);
  if (refs.length > 0) {
    const entry: RefFieldEntry = { refs, isArray: path.includes("[]") };
    if (node["x-telo-context"]) entry.context = node["x-telo-context"] as Record<string, any>;
    map.set(path, entry);
    return;
  }

  // Array — recurse into items
  if (node.type === "array" && node.items) {
    traverseNode(node.items as Record<string, any>, path + "[]", map);
  }

  // Object — recurse into properties
  if (node.properties) {
    for (const [key, propSchema] of Object.entries(node.properties)) {
      traverseNode(propSchema as Record<string, any>, `${path}.${key}`, map);
    }
  }
}
