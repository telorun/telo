import { isTaggedSentinel } from "@telorun/templating";
import { concretePathToPointer, parseConcretePath, readConcretePath } from "../../../lib/concrete-path";
import { isRecord } from "../../../lib/utils";
import { resolveRef } from "../../../schema-utils";

/** Where the `inputs` of an edge's invocation live, plus the schema declared for
 *  them on the source kind (a freeform map for untyped invokes; the caller may
 *  prefer the target's `inputType` over this). */
export interface EdgeInputs {
  /** JSON pointer into the source resource's fields (`/notFoundHandler/inputs`). */
  pointer: string;
  /** The `inputs` property schema declared on the invocation object. */
  inputsProp: Record<string, unknown>;
}

/** Navigates a kind schema to the object schema at a concrete path, descending
 *  into `items` for `[i]` segments and resolving `$ref`. */
function schemaAtConcretePath(schema: unknown, path: string, root: unknown): unknown {
  let node: unknown = schema;
  for (const { key, index } of parseConcretePath(path)) {
    const container = resolveRef(node, root);
    const props = isRecord(container) && isRecord(container.properties) ? container.properties : undefined;
    let prop = props ? resolveRef(props[key], root) : undefined;
    if (index !== undefined && isRecord(prop)) prop = resolveRef(prop.items, root);
    node = prop;
  }
  return node;
}

/** The `inputs` property schema declared on an object schema — directly, or in an
 *  `anyOf` / `oneOf` branch (e.g. the Application `targets` invoke branch). */
function inputsPropOf(objSchema: unknown, root: unknown): Record<string, unknown> | null {
  const s = resolveRef(objSchema, root);
  if (!isRecord(s)) return null;
  if (isRecord(s.properties) && isRecord(s.properties.inputs)) return s.properties.inputs;
  const branches = [
    ...(Array.isArray(s.anyOf) ? s.anyOf : []),
    ...(Array.isArray(s.oneOf) ? s.oneOf : []),
  ];
  for (const branch of branches) {
    const b = resolveRef(branch, root);
    if (isRecord(b) && isRecord(b.properties) && isRecord(b.properties.inputs)) return b.properties.inputs;
  }
  return null;
}

/** Reads the value at a concrete field-map path in a resource's fields. */
/**
 * Resolves the editable `inputs` for an edge whose source ref is at
 * `concretePath`. The invocation object is either the parent of a dispatch-
 * suffixed ref (`notFoundHandler.invoke` → `notFoundHandler`,
 * `routes[2].handler` → `routes[2]`) or, for an inline array step
 * (`targets[0]` = `{ invoke, inputs }`), the item itself. Returns null when the
 * invocation object declares no `inputs` sibling, or when the path holds a bare
 * ref (no inputs). Fully schema-driven — no resource kind is named.
 */
export function resolveEdgeInputs(
  schema: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
  concretePath: string,
): EdgeInputs | null {
  if (!isRecord(schema)) return null;
  const parentMatch = concretePath.match(/^(.+)\.[^.[\]]+$/);
  const candidates: { objPath: string; requireInline: boolean }[] = [];
  if (parentMatch) candidates.push({ objPath: parentMatch[1], requireInline: false });
  candidates.push({ objPath: concretePath, requireInline: true });

  for (const { objPath, requireInline } of candidates) {
    const objSchema = schemaAtConcretePath(schema, objPath, schema);
    const inputsProp = inputsPropOf(objSchema, schema);
    if (!inputsProp) continue;
    if (requireInline) {
      // Only an inline invoke object carries inputs — a bare `!ref` does not.
      const val = readConcretePath(fields, objPath);
      if (!isRecord(val) || isTaggedSentinel(val) || !("invoke" in val)) continue;
    }
    return { pointer: `${concretePathToPointer(objPath)}/inputs`, inputsProp };
  }
  return null;
}
