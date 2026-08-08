/**
 * Navigating a manifest value and a definition schema by path — the primitives
 * the call graph and the zone projection both need.
 *
 * They live here rather than in either consumer because they encode *rules*,
 * not conveniences: which object a JSON Pointer anchors at, and when a path
 * refuses to resolve. Two copies of a rule drift, and the drift is invisible —
 * a second `enclosingOf` that returned the resource root where the first
 * returned `undefined` would silently anchor a correlation pointer at the wrong
 * object rather than failing.
 *
 * Browser-safe: no Node built-ins.
 */

/**
 * The object ENCLOSING a concrete site — its path with the last segment
 * dropped. `routes[2].handler` → the value at `routes[2]`.
 *
 * A slot that IS an array element (`targets[0]`) has no enclosing object: its
 * siblings are other elements, and a pointer must not cross an array boundary —
 * returning the root here would silently do exactly that. The bracket test runs
 * BEFORE the no-dot early return, so a top-level array path refuses too.
 */
export function enclosingOf(root: unknown, concretePath: string): unknown {
  const lastDot = concretePath.lastIndexOf(".");
  const lastSegment = concretePath.slice(lastDot + 1);
  if (lastSegment.includes("[")) return undefined;
  if (lastDot < 0) return root;
  return navigateConcrete(root, concretePath.slice(0, lastDot));
}

/** Navigate a concrete dotted path (`routes[2].handler`, `content.a/b.encoder`). */
export function navigateConcrete(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const rawSegment of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    let segment = rawSegment;
    const indices: number[] = [];
    const bracket = segment.indexOf("[");
    if (bracket >= 0) {
      for (const m of segment.slice(bracket).matchAll(/\[(\d+)\]/g)) {
        indices.push(Number(m[1]));
      }
      segment = segment.slice(0, bracket);
    }
    if (segment) current = (current as Record<string, unknown>)[segment];
    for (const index of indices) {
      if (!Array.isArray(current)) return undefined;
      current = current[index];
    }
  }
  return current;
}

/** Resolve a local `#/$defs/<name>` ref against the root schema; any other
 *  schema (including one with no `$ref`) is returned unchanged. */
export function resolveLocalRef(
  schema: Record<string, any> | undefined,
  root: Record<string, any>,
): Record<string, any> | undefined {
  if (!schema) return undefined;
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const resolved = root.$defs?.[ref.slice("#/$defs/".length)];
    if (resolved && typeof resolved === "object") return resolved as Record<string, any>;
  }
  return schema;
}

/** Property schemas of a possibly variant-bearing object schema — `properties`
 *  plus every `oneOf` / `anyOf` / `allOf` branch's. */
export function propertySchemas(
  schema: Record<string, any>,
): Array<[string, Record<string, any>]> {
  const out: Array<[string, Record<string, any>]> = [];
  if (schema.properties && typeof schema.properties === "object") {
    for (const [k, v] of Object.entries(schema.properties)) out.push([k, v as Record<string, any>]);
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (variant?.properties && typeof variant.properties === "object") {
        for (const [k, v] of Object.entries(variant.properties)) {
          out.push([k, v as Record<string, any>]);
        }
      }
    }
  }
  return out;
}
