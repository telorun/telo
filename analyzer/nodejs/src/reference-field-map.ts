/** An entry for a field that carries one or more x-telo-ref constraints. */
export interface RefFieldEntry {
  /** One or more canonical ref strings ("namespace/module#TypeName" or "telo#TypeName").
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
 *  Three shapes flow through here:
 *   - `{kind, name}` (optionally with runtime call args) → named reference, NOT inline.
 *   - `{kind, ...config}` with no name → inline definition with config; extract.
 *   - `{kind}` alone (bare kind, no name) → inline singleton — extract a fresh
 *     stateless resource. Lets simple stateless kinds be used inline without
 *     boilerplate (e.g. `encoder: {kind: Ndjson.Encoder}`, `invoke: {kind: Run.Throw}`).
 *
 *  A named reference (has string `name`) may carry extra keys (e.g. `inputs`)
 *  that are runtime call parameters — those are never inline resources. */
export function isInlineResource(val: Record<string, unknown>): boolean {
  if (typeof val.name === "string") return false;
  if (typeof val.kind !== "string") return false;
  return true;
}

/** A value found at a field-map path, paired with the concrete path that
 *  produced it. `path` has every `[]` substituted with `[N]` and every `{}`
 *  substituted with the actual map key, matching the format produced by
 *  `buildPositionIndex`. Used so diagnostics emitted against a specific
 *  array element / map entry can be resolved back to a YAML range. */
export interface ResolvedFieldEntry {
  value: unknown;
  path: string;
}

/** Resolves all `{value, path}` entries at a field map path in a resource
 *  config. The returned `path` is the concrete dotted path produced by the
 *  substitutions below, matching the format `buildPositionIndex` keys on.
 *  Path-segment markers accepted in the input `path`:
 *   - `[]`  iterate array values at this key, substituting `[N]` per item
 *           (e.g. `routes[]` → `routes[0]`, `routes[1]`, …).
 *   - `{}`  iterate map values (every value in an `additionalProperties`-typed
 *           object — used for fields like `content[mime]` whose schema declares
 *           a key-as-MIME map). Substituted with the literal map key joined by
 *           a dot, so the input `content.{}.encoder` yields concrete paths
 *           like `content.application/json.encoder`. */
export function resolveFieldEntries(obj: unknown, path: string): ResolvedFieldEntry[] {
  const parts = path.split(".");
  let current: ResolvedFieldEntry[] = [{ value: obj, path: "" }];
  for (const part of parts) {
    if (part === "{}") {
      const next: ResolvedFieldEntry[] = [];
      for (const entry of current) {
        if (!entry.value || typeof entry.value !== "object") continue;
        for (const [k, v] of Object.entries(entry.value as Record<string, unknown>)) {
          if (v != null) {
            next.push({ value: v, path: entry.path ? `${entry.path}.${k}` : k });
          }
        }
      }
      current = next;
      continue;
    }
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    const next: ResolvedFieldEntry[] = [];
    for (const entry of current) {
      if (!entry.value || typeof entry.value !== "object") continue;
      const val = (entry.value as Record<string, unknown>)[key];
      if (val == null) continue;
      const basePath = entry.path ? `${entry.path}.${key}` : key;
      if (isArray && Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          if (val[i] != null) next.push({ value: val[i], path: `${basePath}[${i}]` });
        }
      } else if (!isArray) {
        next.push({ value: val, path: basePath });
      }
    }
    current = next;
  }
  return current;
}

/** Backwards-compat wrapper that drops the concrete path. Prefer
 *  `resolveFieldEntries` for new code that wants positions. */
export function resolveFieldValues(obj: unknown, path: string): unknown[] {
  return resolveFieldEntries(obj, path).map((e) => e.value);
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
      traverseNode(propSchema as Record<string, any>, key, map, schema);
    }
  }
  return map;
}

export function collectRefs(node: Record<string, any>): string[] {
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

/** Traverses an arbitrary JSON Schema starting at the given path prefix. Used to
 *  expand x-telo-schema-from sub-schemas into nested ref/scope entries so Phase 2
 *  inline normalization and Phase 5 injection see slots that the local field map
 *  hid behind the schema-from indirection. */
export function buildFieldMapAtPath(
  schema: Record<string, any>,
  pathPrefix: string,
): ReferenceFieldMap {
  const map: ReferenceFieldMap = new Map();
  traverseNode(schema, pathPrefix, map, schema);
  return map;
}

function traverseNode(
  node: Record<string, any>,
  path: string,
  map: ReferenceFieldMap,
  root?: Record<string, any>,
  visitedRefs: Set<string> = new Set(),
): void {
  // Local `$ref` is intentionally NOT followed. Descending into shared
  // `$defs` (notably `Run.Sequence`'s `step` definition) would surface
  // ref slots like `steps[].invoke` that Phase 5 then injects live
  // instances into; today's `Run.Sequence` controller calls
  // `instance.invoke()` directly when handed an instance, bypassing
  // the kernel's `runInvoke` emit-Invoked path. The walker fix and the
  // dispatcher fix need to land together — see the follow-up in
  // [kernel/nodejs/plans/reference-syntax-unification.md] and the
  // stopgap in `resource-context.ts:resolveChildren`. `visitedRefs`
  // stays as a parameter so the recursive calls below thread the right
  // signature; turning the descent back on is a single-branch change.
  if (typeof node?.$ref === "string") return;
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
    // A node can mix item-level ref branches (a bare string / `{kind, name}`)
    // with object branches that carry their OWN nested refs — e.g. Application
    // `targets`: a bare ref vs inline `{ invoke }` vs gated `{ ref }`. Descend
    // into the variant objects so those nested slots register too (and their
    // `!ref` sentinels resolve). Pure x-telo-ref branches have no properties
    // and contribute nothing here.
    for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
      const variants = node[variantKey];
      if (!Array.isArray(variants)) continue;
      for (const variant of variants) {
        if (!variant || typeof variant !== "object") continue;
        traverseVariant(variant as Record<string, any>, path, map, root, visitedRefs);
      }
    }
    return;
  }

  // Array — recurse into items
  if (node.type === "array" && node.items) {
    traverseNode(node.items as Record<string, any>, path + "[]", map, root, visitedRefs);
  }

  // Object — recurse into properties
  if (node.properties) {
    for (const [key, propSchema] of Object.entries(node.properties)) {
      traverseNode(propSchema as Record<string, any>, `${path}.${key}`, map, root, visitedRefs);
    }
  }

  // Variant branches — descend into every alternative's properties / items.
  // Schemas that discriminate on shape (Run.Sequence's step kinds:
  // `oneOf: [{properties: {invoke}}, {properties: {try}}, ...]`) hide ref
  // slots inside the branch. Walking each branch surfaces those slots into
  // the field map so downstream passes (ref validation, sentinel
  // resolution, dependency graph) cover them without a runtime fallback.
  // The same field path may be added by multiple branches; the later
  // assignment wins, which is fine — branches with the same field path
  // share the same ref/context configuration (any divergence is already
  // a schema bug).
  for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = node[variantKey];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object") continue;
      traverseVariant(variant as Record<string, any>, path, map, root, visitedRefs);
    }
  }

  // Map — `additionalProperties: { ... }` describes every value in an
  // open-keyed object. Encoder refs nested inside `content[mime]` map
  // entries reach Phase 5 through this branch.
  if (
    node.additionalProperties &&
    typeof node.additionalProperties === "object" &&
    !Array.isArray(node.additionalProperties)
  ) {
    traverseNode(
      node.additionalProperties as Record<string, any>,
      `${path}.{}`,
      map,
      root,
      visitedRefs,
    );
  }
}

/** Walk a single variant of a `oneOf` / `anyOf` / `allOf` branch. Only
 *  the properties / items / map slots are followed — collectRefs at the
 *  variant root is handled by the parent's `collectRefs(node)` already
 *  (anyOf of x-telo-ref branches is the canonical multi-ref shape). */
function traverseVariant(
  variant: Record<string, any>,
  path: string,
  map: ReferenceFieldMap,
  root?: Record<string, any>,
  visitedRefs: Set<string> = new Set(),
): void {
  if (variant.properties) {
    for (const [key, propSchema] of Object.entries(variant.properties)) {
      traverseNode(propSchema as Record<string, any>, `${path}.${key}`, map, root, visitedRefs);
    }
  }
  if (variant.type === "array" && variant.items) {
    traverseNode(variant.items as Record<string, any>, path + "[]", map, root, visitedRefs);
  }
  if (
    variant.additionalProperties &&
    typeof variant.additionalProperties === "object" &&
    !Array.isArray(variant.additionalProperties)
  ) {
    traverseNode(
      variant.additionalProperties as Record<string, any>,
      `${path}.{}`,
      map,
      root,
      visitedRefs,
    );
  }
}
