/**
 * Whether two versions of a schema document agree on one node's own type — the question a
 * host asks of each entry of a check's `schemaDependencies` to learn whether the check would
 * answer the same against the other version.
 *
 * **A node's own type is exactly what `schema-dependencies.ts` lists it for**: its `type`,
 * `const` and `enum` — an `enum` as the set of its values beside the order its values' JSON
 * types first appear in, which is the order of the union it reads as; the names in `properties` and the patterns in `patternProperties`; a
 * boolean `additionalProperties`; how many
 * members `allOf` / `anyOf` / `oneOf` hold and how many positions `items` / `prefixItems`
 * do; a `$ref`'s text; and what the host's resolver answers for it. Every subschema position
 * is masked — `properties` and `patternProperties` values, `additionalProperties`, `items`, `prefixItems`,
 * `additionalItems`, `not`, `if` / `then` / `else`, the members of the three combinators — so
 * the position's presence and form count (absent, `true`, `false` or a schema) and its
 * content does not: a subschema the check depends on is a listed node of its own, asked
 * about on its own. A `not` schema's form also says whether it holds anything beyond
 * annotations and whether it holds a value keyword, since that is what its reading turns
 * on. Every other keyword (`description`, `required`, `format`, an annotation) is outside
 * the own type, except through what the resolver answers.
 *
 * A pointer naming no node in either document agrees; naming one in only one of them does
 * not.
 */

import type { JsonSchemaDocument, JsonSchemaNode, SchemaTypeAnswer, SchemaTypeResolver } from "./json-schema-type.js";
import { ANNOTATION_KEYWORDS, NEGATION_TYPE_KEYWORDS, nodeAtPointer } from "./json-schema-type.js";

export interface SchemaOwnTypeAgreement {
  /** Asked at the node in each document, as a conversion asks it. */
  readonly resolveSchemaType?: SchemaTypeResolver;
  /**
   * Whether the resolver's two answers say the same. By default a named type agrees with
   * the same name and arguments, and a document with the same document by identity — its
   * node and its root.
   */
  readonly answersAgree?: (left: SchemaTypeAnswer, right: SchemaTypeAnswer) => boolean;
}

/**
 * Whether `pointer` names a node of the same own type in both documents, each pointer
 * relative to its document's `node` and each `#…` reference within it read against its
 * `root` (the node itself where absent).
 */
export function schemaOwnTypesAgree(
  left: JsonSchemaDocument,
  right: JsonSchemaDocument,
  pointer: string,
  agreement: SchemaOwnTypeAgreement = {},
): boolean {
  const leftNode = nodeAtPointer(left.node, pointer);
  const rightNode = nodeAtPointer(right.node, pointer);
  if (leftNode === undefined || rightNode === undefined) return leftNode === rightNode;
  if (!jsonEqual(ownType(leftNode), ownType(rightNode))) return false;
  const resolve = agreement.resolveSchemaType;
  if (!resolve) return true;
  const leftAnswer = resolve({ node: leftNode, root: left.root ?? left.node });
  const rightAnswer = resolve({ node: rightNode, root: right.root ?? right.node });
  if (leftAnswer === undefined || rightAnswer === undefined) return leftAnswer === rightAnswer;
  return (agreement.answersAgree ?? answersAgreeByDefault)(leftAnswer, rightAnswer);
}

/** The marker a masked subschema position holds in an own type. */
const SUBSCHEMA = "subschema";

/** A subschema position's form: a boolean as itself, a schema masked. */
function form(value: unknown): unknown {
  return typeof value === "boolean" ? value : SUBSCHEMA;
}

/** A node's own type as plain data, each subschema position masked. */
function ownType(node: JsonSchemaNode): Record<string, unknown> {
  const own: Record<string, unknown> = {};
  const held = node as Record<string, unknown>;
  for (const keyword of ["type", "const", "$ref"]) {
    if (Object.hasOwn(held, keyword)) own[keyword] = held[keyword];
  }
  if (Object.hasOwn(held, "enum")) own.enum = Array.isArray(held.enum) ? enumSet(held.enum) : { value: held.enum };
  for (const keyword of ["properties", "patternProperties"]) {
    if (!Object.hasOwn(held, keyword)) continue;
    const entries = held[keyword];
    own[keyword] = isObject(entries)
      ? { names: Object.keys(entries).sort(), forms: Object.keys(entries).sort().map((name) => form(entries[name])) }
      : { value: entries };
  }
  for (const keyword of ["additionalProperties", "additionalItems", "if", "then", "else"]) {
    if (Object.hasOwn(held, keyword)) own[keyword] = form(held[keyword]);
  }
  for (const keyword of ["items", "prefixItems"]) {
    if (!Object.hasOwn(held, keyword)) continue;
    const items = held[keyword];
    own[keyword] = Array.isArray(items) ? { tuple: items.map(form) } : form(items);
  }
  if (Object.hasOwn(held, "not")) {
    const negation = held.not;
    own.not = isObject(negation)
      ? {
          constrains: Object.keys(negation).some((keyword) => !ANNOTATION_KEYWORDS.has(keyword)),
          values: Object.keys(negation).some((keyword) => !ANNOTATION_KEYWORDS.has(keyword) && !NEGATION_TYPE_KEYWORDS.includes(keyword)),
        }
      : form(negation);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (!Object.hasOwn(held, keyword)) continue;
    const members = held[keyword];
    own[keyword] = Array.isArray(members) ? { members: members.length } : { value: members };
  }
  return own;
}

/** An `enum` as a set: its distinct values in one order, and the order its JSON types first appear in. */
function enumSet(values: readonly unknown[]): Record<string, unknown> {
  const texts = [...new Set(values.map(canonicalJson))].sort();
  const kinds: string[] = [];
  for (const value of values) {
    const kind = jsonKind(value);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { values: texts, kinds };
}

function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** JSON text with every object's keys sorted, so equal values write alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function answersAgreeByDefault(left: SchemaTypeAnswer, right: SchemaTypeAnswer): boolean {
  if ("name" in left && "name" in right) {
    return left.name === right.name && jsonEqual(left.args ?? [], right.args ?? []);
  }
  if ("document" in left && "document" in right) {
    return (
      left.document.node === right.document.node &&
      (left.document.root ?? left.document.node) === (right.document.root ?? right.document.node)
    );
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON equality: an object's entries regardless of order, a number by `Object.is`. */
function jsonEqual(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (typeof a === "number" && typeof b === "number") {
      if (!Object.is(a, b)) return false;
      continue;
    }
    if (a === b) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let at = 0; at < a.length; at += 1) pending.push([a[at], b[at]]);
      continue;
    }
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([a[key], b[key]]);
    }
  }
  return true;
}
