/**
 * What a union's branches say about WHICH of them a value is: its candidates
 * and its tags, read from the schema and the value's JSON type at the union's
 * node alone (browser-safe, re-imported by the kernel through the one judge).
 *
 * A branch is a CANDIDATE when its own schema does not refuse the value's JSON
 * type at the node. A TAG is a place below the node that every candidate
 * constrains by `const` / `enum` in its OWN schema — the schema reached through
 * `$ref`, `allOf` and `properties` — and a union has tags only with at least
 * two candidates. A `const` under `items`, `additionalProperties`, a nested
 * `anyOf` / `oneOf`, `dependencies`, `if` / `then` / `else` or `not` is no
 * discriminator of the node, so it is never a tag.
 *
 * A SELECTOR is a member one step below the node that is REQUIRED at the node
 * (by the candidate constraining it, or by the schema holding the union) and
 * constrained by `const` / `enum` in a candidate's own schema without being a
 * tag: a candidate it refuses is the wrong shape for the value, as a missing
 * required member is. Selectors are read only with at least two candidates.
 */

/** What a `$ref` written in `node` names: the node it resolves to, through the
 *  one reader the validator compiles with, or `undefined`. */
export type ReferenceReader = (node: object, ref: string) => object | undefined;

/** A `$ref` the reader could not follow: the union cannot be read. */
export class UnreadableReference extends Error {
  constructor(readonly ref: string) {
    super(`The reference '${ref}' in a union branch resolves to no schema this validator holds.`);
  }
}

export type JsonType = "null" | "boolean" | "integer" | "number" | "string" | "array" | "object";

/** The JSON type of a value. An integral number is `integer`, which also
 *  satisfies `number`. */
export function jsonTypeOf(value: unknown): JsonType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "bigint":
      return "integer";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function admits(declared: unknown, type: JsonType): boolean {
  const names = Array.isArray(declared) ? declared : [declared];
  return names.some((name) => name === type || (name === "number" && type === "integer"));
}

function followed(node: Record<string, unknown>, read: ReferenceReader): Record<string, unknown> | undefined {
  if (typeof node.$ref !== "string") return undefined;
  const target = read(node, node.$ref);
  if (!isSchemaObject(target)) throw new UnreadableReference(node.$ref);
  return target;
}

/** Whether `branch`'s own schema refuses a value of JSON type `type` at its
 *  node: a `type` keyword not admitting it, an `allOf` member that refuses it,
 *  or an `anyOf` / `oneOf` every alternative of which does. */
export function refusesJsonType(branch: unknown, type: JsonType, read: ReferenceReader): boolean {
  const visit = (node: unknown, seen: Set<object>): boolean => {
    if (node === false) return true;
    if (!isSchemaObject(node) || seen.has(node)) return false;
    seen.add(node);
    if ("type" in node && !admits(node.type, type)) return true;
    const target = followed(node, read);
    if (target && visit(target, seen)) return true;
    if (Array.isArray(node.allOf) && node.allOf.some((member) => visit(member, seen))) return true;
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const alternatives = node[keyword];
      if (Array.isArray(alternatives) && alternatives.length > 0 && alternatives.every((member) => visit(member, new Set(seen)))) {
        return true;
      }
    }
    return false;
  };
  return visit(branch, new Set());
}

function escapeSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The places below its node that `branch`'s own schema constrains by `const`
 *  / `enum`, as JSON Pointers relative to the node. */
export function constrainedPlaces(branch: unknown, read: ReferenceReader): Set<string> {
  const places = new Set<string>();
  const visit = (node: unknown, at: string, seen: Set<object>): void => {
    if (!isSchemaObject(node) || seen.has(node)) return;
    seen.add(node);
    if (at !== "" && ("const" in node || Array.isArray(node.enum))) places.add(at);
    const target = followed(node, read);
    if (target) visit(target, at, seen);
    if (Array.isArray(node.allOf)) for (const member of node.allOf) visit(member, at, seen);
    if (isSchemaObject(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) visit(child, `${at}/${escapeSegment(key)}`, new Set(seen));
    }
  };
  visit(branch, "", new Set());
  return places;
}

/** The members one step below its node that `branch`'s own schema constrains by
 *  `const` / `enum` AND requires, with `holder`'s own `required` counted as
 *  the branch's. */
function selectedMembers(branch: unknown, holder: unknown, read: ReferenceReader): Set<string> {
  const required = new Set<string>();
  const collect = (node: unknown, seen: Set<object>): void => {
    if (!isSchemaObject(node) || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node.required)) for (const name of node.required) if (typeof name === "string") required.add(name);
    const target = followed(node, read);
    if (target) collect(target, seen);
    if (Array.isArray(node.allOf)) for (const member of node.allOf) collect(member, seen);
  };
  collect(branch, new Set());
  if (isSchemaObject(holder) && Array.isArray(holder.required)) {
    for (const name of holder.required) if (typeof name === "string") required.add(name);
  }
  const members = new Set<string>();
  for (const place of constrainedPlaces(branch, read)) {
    const segments = place.split("/");
    if (segments.length !== 2) continue;
    const name = segments[1]!.replace(/~1/g, "/").replace(/~0/g, "~");
    if (required.has(name)) members.add(place);
  }
  return members;
}

/** What a union's branches say of a value of one JSON type. */
export interface UnionReading {
  /** Per branch, whether it is a candidate. */
  readonly candidate: readonly boolean[];
  /** The tags, relative to the union's node, in the first candidate's order. */
  readonly tags: readonly string[];
  /** The selectors, relative to the union's node: never a tag. */
  readonly selectors: readonly string[];
}

/** The candidates, tags and selectors of the union `branches`, held by the
 *  schema `holder`, for a value of JSON type `type`. Throws
 *  {@link UnreadableReference} for a reference it cannot follow. */
export function readUnion(branches: readonly unknown[], type: JsonType, read: ReferenceReader, holder?: unknown): UnionReading {
  const candidate = branches.map((branch) => !refusesJsonType(branch, type, read));
  const open = branches.filter((_, i) => candidate[i]);
  if (open.length < 2) return { candidate, tags: [], selectors: [] };
  const [first, ...rest] = open.map((branch) => constrainedPlaces(branch, read));
  const tags = [...first!].filter((place) => rest.every((places) => places.has(place)));
  const selectors: string[] = [];
  for (const branch of open) {
    for (const place of selectedMembers(branch, holder, read)) {
      if (!tags.includes(place) && !selectors.includes(place)) selectors.push(place);
    }
  }
  return { candidate, tags, selectors };
}
