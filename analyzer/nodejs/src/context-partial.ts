/**
 * `x-telo-context-partial: true` — on a binding of an `x-telo-context`, or a
 * member beneath one: the node is SOME of a record's properties. Whatever object
 * type the node resolves to — through its typing annotation (`x-telo-context-
 * from`, `-from-root`, `-from-referrer`, …) or its own `properties` — every
 * member of it becomes optional and nullable, so a member read is judged
 * against the record (an unknown one is `CEL_UNKNOWN_FIELD`) while a read
 * beneath a member is `CEL_NULLABLE_ACCESS` unless guarded.
 *
 * A modifier, never a typing: it sits beside the annotation that types the node
 * and is applied after it, on the expanded context, so a type a referrer gives
 * already partial is left as it is. A resolved type that is no object is left
 * unchanged.
 *
 * This file is the one reader of the value, of the type it gives and of its
 * strict half (`validate-match-for.ts` reports it). The scope rule applies it
 * (`cel-scope.ts`). Analyzer-only: the kernel reads no context.
 *
 * Browser-safe: no Node built-ins.
 */
import { TYPING_ANNOTATIONS, CONTEXT_FROM_REFERRER } from "./context-from-referrer.js";

export const CONTEXT_PARTIAL = "x-telo-context-partial";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

/** Whether `node` is marked partial. */
export function isPartial(node: unknown): boolean {
  return isSchema(node) && node[CONTEXT_PARTIAL] === true;
}

/** The JSON types `schema` declares, or undefined when it declares none. */
function declaredTypes(schema: Schema): readonly string[] | undefined {
  const type = schema.type;
  if (typeof type === "string") return [type];
  return Array.isArray(type) ? type.filter((each): each is string => typeof each === "string") : undefined;
}

/** Whether `schema` is an object type: one declaring `object` among its types,
 *  or, declaring none, `properties`. */
function isObjectType(schema: Schema): boolean {
  const types = declaredTypes(schema);
  return types ? types.includes("object") : isSchema(schema.properties);
}

/** Whether `schema` already admits null. */
function admitsNull(schema: Schema): boolean {
  if (Object.keys(schema).length === 0 || schema.nullable === true) return true;
  if (declaredTypes(schema)?.includes("null")) return true;
  return ["anyOf", "oneOf"].some(
    (key) => Array.isArray(schema[key]) && schema[key].some((branch: unknown) => isSchema(branch) && admitsNull(branch)),
  );
}

/**
 * `schema` with every member optional and nullable — its `properties`, its
 * `patternProperties` and its `additionalProperties` schema — when it is an
 * object type; `schema` itself otherwise. `withNull` adds null to a member that
 * does not admit it yet (the scope rule's, taken as an argument because the
 * module holding it reaches this one). Applying it twice gives what applying it
 * once does.
 */
export function partialObject(schema: Schema, withNull: (member: Schema) => Schema): Schema {
  if (!isObjectType(schema)) return schema;
  const nullable = (member: unknown): unknown => (isSchema(member) && !admitsNull(member) ? withNull(member) : member);
  const { required: _required, ...out } = schema;
  for (const map of ["properties", "patternProperties"] as const) {
    if (!isSchema(schema[map])) continue;
    out[map] = Object.fromEntries(Object.entries(schema[map] as Schema).map(([key, member]) => [key, nullable(member)]));
  }
  if (isSchema(schema.additionalProperties)) out.additionalProperties = nullable(schema.additionalProperties);
  return out;
}

/** The annotations that give a node its type; the modifier needs one of them,
 *  or `properties` of the node's own. */
const TYPINGS: readonly string[] = [...TYPING_ANNOTATIONS, CONTEXT_FROM_REFERRER];

/** A typing that always yields a collection, never an object. */
const COLLECTION_TYPING = "x-telo-context-collection-from";

export type PartialProblem =
  | { readonly code: "SCHEMA_VIOLATION"; readonly message: string }
  | { readonly code: "CONTEXT_PARTIAL_INVALID"; readonly message: string };

/**
 * Why the mark on `node` is malformed or misplaced, or undefined. `where` names
 * it as the diagnostic does; `inBinding` says the node is a binding — a property
 * of an `x-telo-context` — or a member reached from one through `properties`.
 */
export function partialProblem(node: Schema, where: string, inBinding: boolean): PartialProblem | undefined {
  if (node[CONTEXT_PARTIAL] !== true) {
    return {
      code: "SCHEMA_VIOLATION",
      message: `'${where}' takes only 'true' — the node is some of its object type's members; remove it otherwise.`,
    };
  }
  if (!inBinding) {
    return {
      code: "CONTEXT_PARTIAL_INVALID",
      message:
        `'${where}' is read only on a binding — a property of an 'x-telo-context' — or a member beneath ` +
        `one, so here it changes nothing.`,
    };
  }
  const types = declaredTypes(node);
  if (types && !types.includes("object")) {
    return {
      code: "CONTEXT_PARTIAL_INVALID",
      message: `'${where}' makes the members of an object optional, and the node is declared ${types.join(" or ")}, never an object.`,
    };
  }
  if (COLLECTION_TYPING in node) {
    return {
      code: "CONTEXT_PARTIAL_INVALID",
      message: `'${where}' makes the members of an object optional, and '${COLLECTION_TYPING}' types the node as a collection, never an object.`,
    };
  }
  if (!TYPINGS.some((key) => key in node) && !isSchema(node.properties)) {
    return {
      code: "CONTEXT_PARTIAL_INVALID",
      message:
        `'${where}' makes the members of the node's object type optional, and nothing gives the node one: ` +
        `write a typing annotation beside it ('x-telo-context-from', 'x-telo-context-from-root', ` +
        `'x-telo-context-from-referrer', …) or declare its 'properties' on the node itself.`,
    };
  }
  return undefined;
}
