import { valueTypeOf } from "@telorun/sdk";
import { isRecord } from "../../../lib/utils";
import { getTopologyRole, type VariantMeta } from "../../../schema-utils";

/**
 * Writes into a step body at a JSON pointer.
 *
 * Each function returns the NEXT value of the resource's whole field map, which
 * the caller commits through an ordinary field write. That is safe for the
 * reason the top-level append is safe: the writer diffs positionally, so
 * appending at any depth is one write at a new index and no sibling entry is
 * re-serialized — its `!ref` tags, quote styles and comments are never touched.
 *
 * Containers along the path are copied rather than mutated, which is what keeps
 * that diff pointed at the one node that changed.
 */

/** Unescapes one JSON Pointer segment. A case key is author-written and may
 *  hold a `/` or a `~`, so the escape is real rather than defensive. */
function parse(pointer: string): string[] {
  return pointer
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Escapes one segment for a pointer this module will parse back. */
export function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function setIn(node: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...string[]];
  if (Array.isArray(node)) {
    const index = Number(head);
    const copy = node.slice();
    copy[index] = setIn(copy[index], rest, value);
    return copy;
  }
  const record = isRecord(node) ? node : {};
  return { ...record, [head]: setIn(record[head], rest, value) };
}

function readIn(node: unknown, path: string[]): unknown {
  let current = node;
  for (const key of path) {
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
}

/** Appends `value` to the array at `pointer`, treating a missing or non-array
 *  node as empty — a body never written and one written empty are the same
 *  thing to append to. */
export function appendAt(
  fields: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  return setIn(fields, parse(pointer), [...readBody(fields, pointer), value]) as Record<
    string,
    unknown
  >;
}

/** Merges `patch` into the object at `pointer`, keeping what is already there —
 *  how a step gains the fields that say what it does without losing its name,
 *  its guard or its position. */
export function mergeAt(
  fields: Record<string, unknown>,
  pointer: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const path = parse(pointer);
  const current = readIn(fields, path);
  return setIn(fields, path, { ...(isRecord(current) ? current : {}), ...patch }) as Record<
    string,
    unknown
  >;
}

/** The body at `pointer` as a list — a missing or non-array node reads empty,
 *  since a body never written and one written empty hold the same steps. */
export function readBody(fields: Record<string, unknown>, pointer: string): unknown[] {
  const current = readIn(fields, parse(pointer));
  return Array.isArray(current) ? current : [];
}

/** Writes `value` at `pointer` — how a body that does not exist yet is created. */
export function writeAt(
  fields: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  return setIn(fields, parse(pointer), value) as Record<string, unknown>;
}

/** A name no step in the WHOLE body is using — `steps.<name>.result` is read
 *  across branches, so uniqueness within one branch is not uniqueness. A step's
 *  result is reachable only through its name, so a new one gets one rather than
 *  being left anonymous. */
export function freshStepName(taken: ReadonlySet<string>): string {
  for (let i = taken.size + 1; ; i++) {
    const name = `step${i}`;
    if (!taken.has(name)) return name;
  }
}

/** A new step of `variant`, carrying its required fields empty so the form has
 *  something to fill and the manifest stays legible until it is filled.
 *
 *  A required BODY is seeded too — `then: []`, `do: []`, `cases: {}` — even
 *  though the list renders bodies itself. Leaving them out was what made every
 *  control-flow step invalid the moment it was created: the schema requires the
 *  body beside its predicate, so `if:` alone matches no alternative, and the
 *  list only renders bodies that exist, so there was nothing to click to fix
 *  it. An empty body is valid, and it renders as the drop zone that lets the
 *  step be filled.
 *
 *  What stays out is the invoke target and its arguments: a reference cannot be
 *  seeded empty — a blank one is a broken reference rather than an unfinished
 *  one — so those are picked in the step's form. */
export function newStep(variant: VariantMeta, name: string): Record<string, unknown> {
  const step: Record<string, unknown> = { name };
  const picked = new Set(["invoke", "inputs"]);
  for (const field of variant.requiredFields) {
    if (field === "name") continue;
    const props = isRecord(variant.schema.properties) ? variant.schema.properties : {};
    const prop = props[field];
    const role = getTopologyRole(prop);
    if (typeof role === "string" && picked.has(role)) continue;
    // A slot holding a live instance — bytes, a stream — has no value a YAML
    // author could write, so seeding it writes something the schema rejects.
    // Left unwritten, exactly as a reference is.
    if (valueTypeOf(prop)?.representation === "instance") continue;
    step[field] = defaultFor(prop);
  }
  return step;
}

/** A starting value the schema would accept.
 *
 *  What the schema DECLARES comes first — a `default`, then a `const`, then the
 *  first `enum` member — because a closed vocabulary has no empty member: `""`
 *  at an enum-valued field is a violation on a step the author has just created,
 *  which is the state this seeding exists to avoid. Only with nothing declared
 *  does the type's own empty value apply, and a field whose value is not
 *  expressible in YAML at all (bytes, a stream) is left unwritten rather than
 *  seeded with a lie. */
function defaultFor(prop: unknown): unknown {
  if (!isRecord(prop)) return "";
  if (prop.default !== undefined) return prop.default;
  if (prop.const !== undefined) return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  const type = prop.type;
  if (type === "array") return [];
  if (type === "object") return {};
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return 0;
  return "";
}
