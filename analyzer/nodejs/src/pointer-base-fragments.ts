/**
 * **The recursive fragments a pointer `$ref`'s base must carry.**
 *
 * A JSON Pointer `$ref` (`#/$defs/Column/properties/header`,
 * `telo:Ui/Action#/properties/enabled`) whose target is itself a reference to a
 * named shape makes a validator compile that shape against the pointer's BASE
 * document — the document the pointer resolves in — rather than against the
 * shape's own. The shape's `#/$defs/telo:<Fragment>` pointers then resolve
 * against the base, which holds none of them, and the schema fails to compile.
 *
 * So a schema is registered and compiled with every hoisted fragment definition
 * of every named shape it reaches, transitively, beside its own. The reserved
 * `telo:` namespace is what makes the merge safe: two documents holding
 * `telo:Message` hold the same fragment.
 *
 * Browser-safe: no Node built-ins.
 */
import { isHoistedFragmentDefKey } from "./manifest-schemas.js";
import { schemaReferenceParts, type NamedShapeLookup } from "./schema-reference.js";

type Schema = Record<string, any>;

const isObject = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The ids of the named shapes `node` references anywhere beneath it. */
function referencedShapes(node: unknown, out: Set<string>, seen: Set<object>): Set<string> {
  if (!node || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) referencedShapes(item, out, seen);
    return out;
  }
  const record = node as Schema;
  if (typeof record.$ref === "string") {
    const { shape } = schemaReferenceParts(record.$ref);
    if (shape !== undefined) out.add(shape);
  }
  for (const value of Object.values(record)) referencedShapes(value, out, seen);
  return out;
}

const hoistedDefsOf = (document: Schema): [string, unknown][] =>
  isObject(document.$defs)
    ? Object.entries(document.$defs).filter(([key]) => isHoistedFragmentDefKey(key))
    : [];

/**
 * `schema` with the hoisted fragment definitions of every named shape it
 * reaches — through `lookup`, at any depth — added to its own `$defs`, or
 * `schema` itself when it lacks none of them. Copy-on-write.
 */
export function withReachedFragmentDefs<T extends Schema>(schema: T, lookup: NamedShapeLookup): T {
  if (!isObject(schema)) return schema;
  const own = new Set(hoistedDefsOf(schema).map(([key]) => key));
  const added: Record<string, unknown> = {};
  const visited = new Set<string>();
  const pending = [...referencedShapes(schema, new Set(), new Set())];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const document = lookup(id);
    if (!isObject(document) || document === schema) continue;
    for (const [key, body] of hoistedDefsOf(document)) {
      if (!own.has(key) && !(key in added)) added[key] = body;
    }
    for (const next of referencedShapes(document, new Set(), new Set())) {
      if (!visited.has(next)) pending.push(next);
    }
  }
  if (Object.keys(added).length === 0) return schema;
  return { ...schema, $defs: { ...(isObject(schema.$defs) ? schema.$defs : {}), ...added } };
}
