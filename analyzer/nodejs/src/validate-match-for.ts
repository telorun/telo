/**
 * `x-telo-match-for` and `x-telo-context-eval` — the two annotations a kind
 * uses to type what a value tree names rather than evaluates.
 *
 * `x-telo-match-for: "<pointer>"` sits on a JSON-Schema-valued field and names,
 * relative to the object enclosing that field, the accessor field the schema is
 * matched against. Where the schema can never hold for the accessor's static
 * type it is `MATCH_UNSATISFIABLE`, judged by definite disjointness alone.
 * `x-telo-context-eval: <mode> | [<mode>…]` on an `x-telo-context` binding
 * names the eval modes the binding exists at; its reader is `context-eval.ts`,
 * and this file is its strict half.
 *
 * Both strict halves report where the annotation is written — a kind's
 * `schema:` or a `Telo.JsonSchema`'s — for the entry's own modules; neither has
 * a kernel twin, because the kernel reads neither annotation.
 *
 * Browser-safe: no Node built-ins.
 */
import {
  concreteEvalPaths,
  declaredEvalMode,
  MATCH_FOR_ANNOTATION,
  matchForSitesOf,
  type NamedShapeLookup,
} from "./eval-paths.js";
import { resolveSchemaPointer, propertySchemas } from "./manifest-navigation.js";
import { CONTEXT_EVAL, contextEvalValueProblem } from "./context-eval.js";
import { CONTEXT_FROM_REFERRER, fromReferrerProblem } from "./context-from-referrer.js";
import { ITEM_FILLS, itemFillsValueProblem } from "./context-fill-cycle.js";
import { ELEMENT_FROM_ITEM, readRelativePointer, relativePointerRefusal, type SchemaLevel } from "./element-from-item.js";
import { pointerSegments, renderValuePath, type ValuePath } from "./text-slot.js";
import { dispatchReads } from "./invocation-contract.js";
import { enclosingKeys, placeAt, type ReadReporter } from "./read-place.js";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema =>
  !!node && typeof node === "object" && !Array.isArray(node);

export interface AnnotationProblem {
  readonly code:
    | "SCHEMA_VIOLATION"
    | "MATCH_FOR_INVALID"
    | "CONTEXT_EVAL_MISPLACED"
    | "ELEMENT_FROM_ITEM_INVALID"
    | "CONTEXT_FROM_REFERRER_INVALID"
    | "CONTEXT_ITEM_FILLS_INVALID";
  readonly warning?: true;
  /** Where the annotation is written, from the document root. */
  readonly path: string;
  readonly message: string;
}

/** Where a schema node sits relative to its parent. */
type Role =
  | { kind: "property"; enclosing: Schema }
  | { kind: "binding"; field: readonly SchemaLevel[] | undefined }
  | { kind: "other" };

/**
 * Every misuse of the annotations a value tree is typed with — `x-telo-match-for`,
 * `x-telo-context-eval`, `x-telo-context-element-from-item` — in one schema
 * document, `at` naming where the schema is written in its manifest
 * (`["schema"]`). `shapes` resolves a named shape a pointer's target is written
 * as; `isResource` says the document is a kind's schema rather than a named
 * shape's.
 */
export function annotationDeclarationProblems(
  schema: unknown,
  at: ValuePath,
  shapes: NamedShapeLookup,
  isResource = true,
): AnnotationProblem[] {
  if (!isSchema(schema)) return [];
  const root = schema;
  const problems: AnnotationProblem[] = [];
  const seen = new Set<object>();
  /** `levels` is the instance-level walk from the document root to `node`, or
   *  undefined where the walk cannot tell (a `$defs` entry, a context schema). */
  const visit = (
    node: unknown,
    path: ValuePath,
    role: Role,
    underAccessor: boolean,
    levels: readonly SchemaLevel[] | undefined,
  ): void => {
    if (!isSchema(node) || seen.has(node)) return;
    seen.add(node);
    const here = levels && levels.length > 0 ? [...levels.slice(0, -1), { node, key: levels[levels.length - 1]!.key }] : levels;
    const accessorHere = underAccessor || declaredEvalMode(node) === "accessor";

    if (MATCH_FOR_ANNOTATION in node) {
      const where = renderValuePath([...path, MATCH_FOR_ANNOTATION]);
      const pointer = node[MATCH_FOR_ANNOTATION];
      if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/"))) {
        problems.push({
          code: "SCHEMA_VIOLATION",
          path: where,
          message: `'${where}' must be a JSON Pointer string, relative to the object enclosing the field, naming the accessor field the schema is matched against.`,
        });
      } else {
        const refusal =
          role.kind !== "property"
            ? "it must sit on a property of an object schema, whose enclosing object holds the accessor"
            : accessorHere
              ? "the field is at or beneath an accessor field, whose value is named rather than read"
              : targetRefusal(role.enclosing, pointer, schema, shapes);
        if (refusal) {
          problems.push({
            code: "MATCH_FOR_INVALID",
            path: where,
            message: `'${where}: ${pointer}' names no accessor to match against: ${refusal}.`,
          });
        }
      }
    }

    if (CONTEXT_EVAL in node) {
      const where = renderValuePath([...path, CONTEXT_EVAL]);
      const problem = contextEvalValueProblem(node[CONTEXT_EVAL]);
      if (problem !== undefined) {
        problems.push({
          code: "SCHEMA_VIOLATION",
          path: where,
          message: `'${where}' names the eval modes a binding exists at, and ${problem}.`,
        });
      } else if (role.kind !== "binding") {
        problems.push({
          code: "CONTEXT_EVAL_MISPLACED",
          warning: true,
          path: where,
          message: `'${where}' is read only on a binding — a property of an 'x-telo-context' — so here it marks nothing.`,
        });
      }
    }

    if (CONTEXT_FROM_REFERRER in node) {
      const where = renderValuePath([...path, CONTEXT_FROM_REFERRER]);
      const problem = fromReferrerProblem(node, where, role.kind === "binding");
      if (problem) problems.push({ code: problem.code, path: where, message: problem.message });
    }

    if (ITEM_FILLS in node) {
      const where = renderValuePath([...path, ITEM_FILLS]);
      const problem = itemFillsValueProblem(node[ITEM_FILLS]);
      const field = role.kind === "binding" ? role.field?.[role.field.length - 1]?.node : undefined;
      if (problem !== undefined) {
        problems.push({
          code: "SCHEMA_VIOLATION",
          path: where,
          message: `'${where}' names the member each item of the list fills, and ${problem}.`,
        });
      } else if (role.kind !== "binding") {
        problems.push({
          code: "CONTEXT_ITEM_FILLS_INVALID",
          path: where,
          message: `'${where}' is read only on a binding — a property of an 'x-telo-context' — so here it says nothing.`,
        });
      } else if (role.field && field && !isArraySchema(field)) {
        problems.push({
          code: "CONTEXT_ITEM_FILLS_INVALID",
          path: where,
          message: `'${where}' says what each item of a list fills, but the region it sits in is declared on a field that is no list.`,
        });
      }
    }

    if (ELEMENT_FROM_ITEM in node) {
      const where = renderValuePath([...path, ELEMENT_FROM_ITEM]);
      const written = node[ELEMENT_FROM_ITEM];
      const pointer = readRelativePointer(written);
      if (!pointer) {
        problems.push({
          code: "SCHEMA_VIOLATION",
          path: where,
          message: `'${where}' must be a relative JSON pointer — the levels to climb from the object holding the field, then a JSON Pointer to the field whose chain names the collection ('0/rows', '2/rows').`,
        });
      } else if (role.kind === "binding" && role.field) {
        const refusal = relativePointerRefusal(role.field, pointer, root, shapes, isResource);
        if (refusal) {
          problems.push({
            code: "ELEMENT_FROM_ITEM_INVALID",
            path: where,
            message: `'${where}: ${String(written)}' names no collection to type the binding from: ${refusal}.`,
          });
        }
      }
    }

    const other: Role = { kind: "other" };
    const deeper = (key: string | undefined, child: unknown) =>
      here && isSchema(child) ? [...here, { node: child, key }] : undefined;
    for (const map of ["properties", "patternProperties"] as const) {
      if (!isSchema(node[map])) continue;
      for (const [key, child] of Object.entries(node[map] as Schema)) {
        visit(
          child,
          [...path, map, key],
          map === "properties" ? { kind: "property", enclosing: node } : other,
          accessorHere,
          deeper(map === "properties" ? key : "*", child),
        );
      }
    }
    for (const map of ["$defs", "definitions"] as const) {
      if (!isSchema(node[map])) continue;
      for (const [key, child] of Object.entries(node[map] as Schema)) {
        visit(child, [...path, map, key], other, false, undefined);
      }
    }
    visit(node.additionalProperties, [...path, "additionalProperties"], other, accessorHere, deeper("*", node.additionalProperties));
    for (const key of ["not", "if", "then", "else", "contains", "x-telo-error-context"]) {
      visit(node[key], [...path, key], other, accessorHere, key === "x-telo-error-context" ? undefined : here);
    }
    if (Array.isArray(node.items)) {
      node.items.forEach((item, i) => visit(item, [...path, "items", i], other, accessorHere, deeper("*", item)));
    } else visit(node.items, [...path, "items"], other, accessorHere, deeper("*", node.items));
    for (const key of ["oneOf", "anyOf", "allOf"] as const) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((branch: unknown, i: number) => visit(branch, [...path, key, i], other, accessorHere, here));
    }
    const context = node["x-telo-context"];
    if (isSchema(context)) {
      // Its bindings first, so the walk of the context below meets each as seen.
      if (isSchema(context.properties)) {
        for (const [key, binding] of Object.entries(context.properties as Schema)) {
          visit(binding, [...path, "x-telo-context", "properties", key], { kind: "binding", field: here }, false, undefined);
        }
      }
      visit(context, [...path, "x-telo-context"], other, false, undefined);
    }
  };
  visit(schema, at, { kind: "other" }, false, [{ node: schema, key: undefined }]);
  return problems;
}

/** A `$ref` followed to the node it names, with the document that node's own
 *  references resolve against. */
function deref(node: Schema, document: Schema, shapes: NamedShapeLookup): [Schema, Schema] {
  const seen = new Set<object>();
  let current = node;
  let doc = document;
  while (typeof current.$ref === "string" && !seen.has(current)) {
    seen.add(current);
    const local = current.$ref.startsWith("#");
    const target = local ? resolveSchemaPointer(doc, current.$ref) : shapes(current.$ref);
    if (!isSchema(target)) break;
    if (!local) doc = target;
    current = target;
  }
  return [current, doc];
}

function isArraySchema(node: Schema): boolean {
  return node.items !== undefined || node.type === "array";
}

/** Why `pointer`, from `enclosing`, names no accessor field — or undefined. */
function targetRefusal(
  enclosing: Schema,
  pointer: string,
  document: Schema,
  shapes: NamedShapeLookup,
): string | undefined {
  const segments = pointer === "" ? [] : (pointerSegments(pointer) ?? []);
  let [current, doc] = deref(enclosing, document, shapes);
  let field: Schema | undefined;
  for (const segment of segments) {
    if (isArraySchema(current)) return `'${pointer}' crosses an array, which holds any number of values`;
    const next = propertySchemas(current).find(([key]) => key === segment)?.[1];
    if (!isSchema(next)) return `the enclosing object declares nothing at '${pointer}'`;
    field = next;
    [current, doc] = deref(next, doc, shapes);
  }
  if (!field) return "a pointer must name a field of the enclosing object";
  if (declaredEvalMode(field) === "accessor" || declaredEvalMode(current) === "accessor") return undefined;
  return `the field at '${pointer}' is not an 'x-telo-eval: accessor' field`;
}

/**
 * Why `matches` can never hold for a value of `type` — the reason, or undefined
 * when it may. DEFINITE disjointness only: `type` (an integer is a number),
 * `const`, `enum` and `required` naming a member a closed object lacks, through
 * `properties` a value always has, `items` of a list never empty, `allOf` (one
 * disjoint member suffices) and `anyOf` (every branch disjoint); never `not`.
 * A `type` that is a union is disjoint only from what every branch is.
 */
export function matchUnsatisfiable(
  matches: unknown,
  type: unknown,
  shapes: NamedShapeLookup,
  document?: Schema,
): string | undefined {
  if (!isSchema(matches) || !isSchema(type)) return undefined;
  const [resolved, doc] = deref(type, document ?? type, shapes);
  const alternatives = (resolved.anyOf ?? resolved.oneOf) as unknown;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    const reasons = alternatives.map((branch) =>
      matchUnsatisfiable(matches, branch, shapes, doc),
    );
    return reasons.every((reason) => reason !== undefined) ? reasons[0] : undefined;
  }
  return disjoint(matches, resolved, doc, shapes);
}

function typesOf(schema: Schema): string[] | undefined {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t) => typeof t === "string");
  const values = "const" in schema ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : undefined;
  return values ? [...new Set(values.map(jsonTypeOf))] : undefined;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" || typeof value === "bigint") {
    return typeof value === "bigint" || Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typesMeet(a: string, b: string): boolean {
  if (a === b) return true;
  return (a === "number" && b === "integer") || (a === "integer" && b === "number");
}

function valueFitsTypes(value: unknown, types: readonly string[]): boolean {
  const own = jsonTypeOf(value);
  return types.some((t) => t === own || (t === "number" && own === "integer"));
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function constRefusal(value: unknown, type: Schema): string | undefined {
  const types = typesOf(type);
  if ("const" in type && !equal(type.const, value)) return `the value is always ${describe(type.const)}`;
  if (Array.isArray(type.enum) && !type.enum.some((member) => equal(member, value))) {
    return `the value is one of ${type.enum.map(describe).join(", ")}`;
  }
  if (types && !valueFitsTypes(value, types)) return `the value is ${types.join(" or ")}`;
  return undefined;
}

function disjoint(matches: Schema, type: Schema, document: Schema, shapes: NamedShapeLookup): string | undefined {
  if (Array.isArray(matches.allOf)) {
    for (const member of matches.allOf) {
      const reason = isSchema(member) ? disjoint(member, type, document, shapes) : undefined;
      if (reason) return reason;
    }
  }
  if (Array.isArray(matches.anyOf) && matches.anyOf.length > 0) {
    const reasons = matches.anyOf.map((branch: unknown) =>
      isSchema(branch) ? disjoint(branch, type, document, shapes) : undefined,
    );
    if (reasons.every((reason: string | undefined) => reason !== undefined)) return reasons[0];
  }

  const types = typesOf(type);
  const wanted = typeof matches.type === "string" ? [matches.type] : Array.isArray(matches.type) ? matches.type : undefined;
  if (wanted && types) {
    if (!wanted.some((w: string) => types.some((t) => typesMeet(w, t)))) {
      return `it requires ${wanted.join(" or ")}, and the value is ${types.join(" or ")}`;
    }
  }
  if ("const" in matches) {
    const reason = constRefusal(matches.const, type);
    if (reason) return `it requires ${describe(matches.const)}, and ${reason}`;
  }
  if (Array.isArray(matches.enum)) {
    if (matches.enum.every((member: unknown) => constRefusal(member, type) !== undefined)) {
      return `it requires one of ${matches.enum.map(describe).join(", ")}, and ${constRefusal(matches.enum[0], type) ?? "none can hold"}`;
    }
  }

  const declared = isSchema(type.properties) ? (type.properties as Schema) : {};
  const closed = type.additionalProperties === false && type.patternProperties === undefined;
  const objectValue = !types || types.includes("object");
  if (Array.isArray(matches.required) && closed && objectValue) {
    const missing = matches.required.find((name: unknown) => typeof name === "string" && !(name in declared));
    if (missing !== undefined) return `it requires the member '${missing}', which the value's closed object never has`;
  }
  if (isSchema(matches.properties)) {
    const always = new Set<string>([
      ...(Array.isArray(matches.required) ? matches.required : []),
      ...(Array.isArray(type.required) ? type.required : []),
    ]);
    for (const [name, member] of Object.entries(matches.properties as Schema)) {
      if (!always.has(name) || !isSchema(declared[name])) continue;
      const [memberType, doc] = deref(declared[name], document, shapes);
      const reason = matchUnsatisfiable(member, memberType, shapes, doc);
      if (reason) return `its member '${name}' can never hold: ${reason}`;
    }
  }
  if (isSchema(matches.items) && isSchema(type.items)) {
    const nonEmpty = (matches.minItems ?? 0) >= 1 || (type.minItems ?? 0) >= 1;
    if (nonEmpty) {
      const [itemType, doc] = deref(type.items, document, shapes);
      const reason = matchUnsatisfiable(matches.items, itemType, shapes, doc);
      if (reason) return `its items can never hold: ${reason}`;
    }
  }
  return undefined;
}

/** One `x-telo-match-for` field a value holds: its keys, and the keys of the
 *  accessor field it names, both in the value. */
export interface MatchPlace {
  readonly keys: readonly (string | number)[];
  readonly accessorKeys: readonly (string | number)[];
}

/**
 * Every `x-telo-match-for` field `value` holds, under `kindSchema`, with the
 * accessor field it names — each place once, however many sites (one per union
 * branch declaring the field, one per way a recursive shape is entered) name
 * it. A place is found where the value holds one, whatever it holds.
 */
export function matchPlaces(
  value: Record<string, unknown>,
  kindSchema: Schema,
  shapes: NamedShapeLookup,
  isExpression: (node: unknown) => boolean,
): MatchPlace[] {
  const out: MatchPlace[] = [];
  const judged = new Set<string>();
  for (const site of matchForSitesOf(kindSchema, shapes)) {
    const pointer = site.pointer === "" ? [] : pointerSegments(site.pointer);
    if (!pointer || pointer.length === 0) continue;
    for (const parts of concreteEvalPaths(value, site.path, isExpression)) {
      if (at(value, parts) === undefined) continue;
      const place = parts.join("\u0000");
      if (judged.has(place)) continue;
      judged.add(place);
      out.push({ keys: keysOf(value, parts), accessorKeys: keysOf(value, [...parts.slice(0, -1), ...pointer]) });
    }
  }
  return out;
}

/**
 * Why the schema `matches` written at a `x-telo-match-for` field can never
 * hold for the accessor it names — `accessor` its value, `typed` the static
 * type its expression was typed as (undefined: open or unknown); a literal
 * accessor is judged as `{ const: <value> }`. Undefined where it may hold, or
 * where nothing decides.
 */
export function unsatisfiedMatch(
  matches: unknown,
  accessor: unknown,
  typed: Schema | undefined,
  shapes: NamedShapeLookup,
  isExpression: (node: unknown) => boolean,
): string | undefined {
  if (!isSchema(matches) || isExpression(matches)) return undefined;
  if (accessor === undefined) return undefined;
  const type = isExpression(accessor) ? typed : { const: accessor };
  if (!type) return undefined;
  return matchUnsatisfiable(matches, type, shapes);
}

/** `parts` as keys of `value`: an index where the value holds a list. */
function keysOf(value: unknown, parts: readonly string[]): (string | number)[] {
  const keys: (string | number)[] = [];
  let current = value;
  for (const part of parts) {
    keys.push(Array.isArray(current) ? Number(part) : part);
    current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
  }
  return keys;
}

function at(value: unknown, parts: readonly string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** What `x-telo-match-for` reads: the accessor field it names, from the object
 *  enclosing the annotated field — and what its chain is typed against, which
 *  is the declaration it is written in. */
export const matchForReads: ReadReporter = ({ value, at }) =>
  typeof value === "string"
    ? [
        { kind: "value", keys: placeAt(enclosingKeys(at), value) },
        { kind: "reference", keys: [], transitive: true, reads: dispatchReads },
      ]
    : [];
