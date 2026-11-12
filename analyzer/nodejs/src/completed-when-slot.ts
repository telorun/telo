/**
 * `x-telo-ref` `completedWhen: <pointer>` — a reference slot whose target
 * obtains every input its argument map leaves unbound, before it runs, where a
 * boolean sibling of the slot holds `true` (an action that prompts for what its
 * caller does not bind). The call-site check then reports no required input
 * missing from the map; who guarantees completeness is the target's own rules.
 *
 * This file is the annotation's strict half: the pointer names a sibling of the
 * object enclosing the slot that the schema declares `type: boolean`, and the
 * slot declares the `inputs:` map it completes — `X_TELO_REF_INVALID_COMPLETED_WHEN`,
 * read by `telo check` at a kind's schema and a named shape's, and by the kernel
 * at registration (`ERR_X_TELO_REF_INVALID_COMPLETED_WHEN`).
 *
 * Browser-safe: no Node built-ins.
 */
import { propertySchemas } from "./manifest-navigation.js";
import { followSchemaReferences, type NamedShapeLookup } from "./schema-reference.js";

type Schema = Record<string, any>;

export const COMPLETED_WHEN_CODE = "X_TELO_REF_INVALID_COMPLETED_WHEN";

export interface CompletedWhenProblem {
  readonly code: typeof COMPLETED_WHEN_CODE;
  /** Schema path of the annotation, from `at`. */
  readonly path: string;
  readonly message: string;
}

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

const POINTER = /^(\/([^/~]|~[01])+)+$/;

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** The schema `pointer` names from the object schema `enclosing`, written in
 *  `document`, every reference on the way followed — or undefined. */
function siblingAt(
  enclosing: Schema,
  pointer: string,
  document: Schema,
  lookup: NamedShapeLookup | undefined,
): Schema | undefined {
  let at: { node: Schema; document: Schema | undefined } | undefined = { node: enclosing, document };
  for (const segment of pointerSegments(pointer)) {
    if (!at) return undefined;
    const object = followSchemaReferences(at.node, at.document, lookup);
    const next: unknown = propertySchemas(object.node).find(([key]) => key === segment)?.[1];
    at = isSchema(next) ? { node: next, document: object.document } : undefined;
  }
  return at ? followSchemaReferences(at.node, at.document, lookup).node : undefined;
}

/** The node and its `anyOf` / `oneOf` branches carrying an `x-telo-ref`, each
 *  with the schema path of its annotation. */
function carriers(node: Schema, path: string): { annotation: Schema; path: string }[] {
  const out: { annotation: Schema; path: string }[] = [];
  if (isSchema(node["x-telo-ref"])) out.push({ annotation: node["x-telo-ref"], path });
  for (const key of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(node[key])) continue;
    node[key].forEach((branch: unknown, i: number) => {
      if (isSchema(branch) && isSchema(branch["x-telo-ref"])) out.push({ annotation: branch["x-telo-ref"], path: `${path}.${key}[${i}]` });
    });
  }
  return out;
}

/**
 * Every misdirected `completedWhen` of one schema document: a value that is no
 * JSON Pointer, a slot declaring no `inputs:`, a pointer naming no sibling the
 * schema declares `type: boolean`, or a slot that is no property of an object
 * schema and so has no sibling. A sibling reached by any `$ref` — a local
 * pointer, a named shape or a pointer into one, through `lookup` — is read as
 * what it names. `name` names the document in each message, `at` the schema's
 * path in it.
 */
export function completedWhenProblems(
  schema: unknown,
  name: string,
  at = "schema",
  lookup?: NamedShapeLookup,
): CompletedWhenProblem[] {
  if (!isSchema(schema)) return [];
  const document = schema;
  const problems: CompletedWhenProblem[] = [];
  const asProperty = new Set<object>();
  const declaring: { node: Schema; path: string }[] = [];
  const seen = new Set<object>();
  const claimed = new Set<object>();

  const refuse = (slotPath: string, annotationPath: string, value: unknown, reason: string): void => {
    problems.push({
      code: COMPLETED_WHEN_CODE,
      path: `${annotationPath}.x-telo-ref.completedWhen`,
      message: `${name}: x-telo-ref at '${slotPath}' declares 'completedWhen: ${typeof value === "string" ? value : JSON.stringify(value)}', but ${reason}.`,
    });
  };

  const judge = (enclosing: Schema, slot: Schema, slotPath: string): void => {
    asProperty.add(slot);
    for (const { annotation, path } of carriers(slot, slotPath)) {
      const pointer = annotation.completedWhen;
      if (pointer === undefined) continue;
      if (typeof pointer !== "string" || !POINTER.test(pointer)) {
        refuse(slotPath, path, pointer, "it must be a JSON Pointer naming a boolean sibling of the slot, as '/prompt'");
        continue;
      }
      if (typeof annotation.inputs !== "string") {
        refuse(slotPath, path, pointer, "the slot declares no 'inputs:' argument map for its target to complete");
        continue;
      }
      const sibling = siblingAt(enclosing, pointer, document, lookup);
      if (!sibling) refuse(slotPath, path, pointer, `the object enclosing the slot declares nothing at '${pointer}'`);
      else if (sibling.type !== "boolean") refuse(slotPath, path, pointer, `'${pointer}' is not declared 'type: boolean'`);
    }
  };

  const visit = (node: unknown, path: string): void => {
    if (!isSchema(node) || seen.has(node)) return;
    seen.add(node);
    // A branch carrying the annotation is its slot's, judged with it.
    for (const key of ["anyOf", "oneOf"] as const) {
      if (Array.isArray(node[key])) for (const branch of node[key]) if (isSchema(branch) && branch["x-telo-ref"] !== undefined) claimed.add(branch);
    }
    if (!claimed.has(node) && carriers(node, path).some(({ annotation }) => annotation.completedWhen !== undefined)) {
      declaring.push({ node, path });
    }
    if (isSchema(node.properties)) {
      for (const [key, child] of Object.entries(node.properties as Schema)) {
        // The slot is judged where its annotation is written: a local pointer is
        // this document's own, a named shape's annotation its own check's.
        if (isSchema(child)) judge(node, followSchemaReferences(child, document, undefined).node, `${path}.properties.${key}`);
      }
    }
    for (const map of ["properties", "patternProperties", "$defs", "definitions"] as const) {
      if (!isSchema(node[map])) continue;
      for (const [key, child] of Object.entries(node[map] as Schema)) visit(child, `${path}.${map}.${key}`);
    }
    visit(node.additionalProperties, `${path}.additionalProperties`);
    if (Array.isArray(node.items)) node.items.forEach((item, i) => visit(item, `${path}.items[${i}]`));
    else visit(node.items, `${path}.items`);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((branch: unknown, i: number) => visit(branch, `${path}.${key}[${i}]`));
    }
  };
  visit(schema, at);

  for (const { node, path } of declaring) {
    if (asProperty.has(node)) continue;
    for (const { annotation, path: annotationPath } of carriers(node, path)) {
      if (annotation.completedWhen === undefined) continue;
      refuse(path, annotationPath, annotation.completedWhen, "the slot is no property of an object schema, so it has no sibling to read");
    }
  }
  return problems;
}
