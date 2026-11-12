/**
 * `x-telo-context-nullable-when: { at, equals, absent }` — on a binding of an
 * `x-telo-context`, or a member beneath one: the node may be null where the
 * resource's own value at `at` is one of `equals`, or — `absent: true` — where
 * nothing is there. Whatever type the node resolves to (its own keywords, a
 * referrer's, any other typing annotation), null is added to it there.
 *
 * `at` is a Relative JSON Pointer anchored at the context holder — the object
 * holding the field the region is declared on, the item itself for a region
 * declared on a list's items (the holder `x-telo-context-ref-from` reads) —
 * read in `x-telo-context-element-from-item`'s grammar. It is resolved one
 * segment at a time, a schema `default:` filling a member only where the object
 * holding it is present, as validation fills it. A computed or undecided value
 * counts as a match: doubt means null.
 *
 * This file is the one reader of the value, of what it decides and of the
 * schema walk its strict half (`validate-match-for.ts`) reports along. The
 * scope rule applies it (`cel-scope.ts`).
 *
 * Browser-safe: no Node built-ins.
 */
import { expansionTagOf, isTaggedSentinel } from "@telorun/templating";
import { readRelativePointer, type RelativePointer, type SchemaLevel } from "./element-from-item.js";
import type { NamedShapeLookup } from "./eval-paths.js";
import { propertySchemas } from "./manifest-navigation.js";
import { followSchemaReferences } from "./schema-reference.js";
import { enclosingKeys, placeAt, type ReadPlace, type ReadReporter } from "./read-place.js";

export const NULLABLE_WHEN = "x-telo-context-nullable-when";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

export interface NullableWhen {
  readonly at: RelativePointer;
  /** As written, for a message. */
  readonly pointer: string;
  readonly equals: readonly unknown[];
  readonly absent: boolean;
}

/** The rule `node` declares, or undefined — also for a malformed value, which
 *  the strict half reports. */
export function readNullableWhen(node: unknown): NullableWhen | undefined {
  if (!isSchema(node)) return undefined;
  const value = node[NULLABLE_WHEN];
  if (nullableWhenValueProblem(value) !== undefined) return undefined;
  const { at, equals, absent } = value as { at: string; equals: unknown[]; absent: boolean };
  return { at: readRelativePointer(at)!, pointer: at, equals, absent };
}

/** Why a written value is not `{ at, equals, absent }`, or undefined. */
export function nullableWhenValueProblem(value: unknown): string | undefined {
  if (!isSchema(value)) return "it must be an object '{ at, equals, absent }'";
  const extra = Object.keys(value).filter((key) => key !== "at" && key !== "equals" && key !== "absent");
  if (extra.length > 0) return `'${extra[0]}' is not one of its keys — it takes 'at', 'equals' and 'absent'`;
  if (!readRelativePointer(value.at)) {
    return "'at' must be a relative JSON pointer — the levels to climb from the context holder, then a JSON Pointer ('0/options/mode')";
  }
  if (typeof value.absent !== "boolean") return "'absent' must be true or false — whether a value missing at 'at' makes the node nullable";
  if (!Array.isArray(value.equals)) return "'equals' must be a list of the values at 'at' that make the node nullable";
  if (value.equals.length === 0 && value.absent !== true) return "'equals' is empty and 'absent' is false, so it never applies";
  return undefined;
}

/** One step of a concrete data path: a member name or a list index. */
export type DataToken = string | number;

/**
 * Whether `rule` holds for an expression whose region's holder sits at
 * `holder` in `root`; `schemaAt` answers the schema declared at a data path,
 * whose `default:` fills a member the value leaves out.
 */
export function nullableWhenHolds(
  rule: NullableWhen,
  root: unknown,
  holder: readonly DataToken[],
  schemaAt: (tokens: readonly DataToken[]) => Schema | undefined,
): boolean {
  if (rule.at.up > holder.length) return true;
  const tokens: DataToken[] = holder.slice(0, holder.length - rule.at.up);
  let current: unknown = root;
  for (const token of tokens) {
    if (undecided(current)) return true;
    current = current !== null && typeof current === "object" ? (current as Record<string, unknown>)[token as string] : undefined;
  }
  for (const segment of rule.at.segments) {
    if (undecided(current)) return true;
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(segment)) {
      tokens.push(Number(segment));
      current = current[Number(segment)];
    } else if (isSchema(current)) {
      tokens.push(segment);
      current = segment in current ? current[segment] : schemaAt(tokens)?.default;
    } else {
      current = undefined;
      break;
    }
  }
  if (current === undefined) return rule.absent;
  if (undecided(current)) return true;
  return rule.equals.some((value) => sameJson(value, current));
}

/** A value whose content is known only once it is evaluated or chosen. */
function undecided(value: unknown): boolean {
  return isTaggedSentinel(value) || expansionTagOf(value) !== undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => sameJson((a as any)[key], (b as any)[key]));
}

/** `schema` admitting null as well. An untyped node already admits it. */
export function withNull(schema: Schema): Schema {
  if (schema.type === "null") return schema;
  if (Array.isArray(schema.type)) return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  if (isSchema(schema.properties) || schema.additionalProperties !== undefined) return { ...schema, type: ["object", "null"] };
  if (Object.keys(schema).length === 0) return schema;
  return { anyOf: [schema, { type: "null" }] };
}

/** A schema node read through its `$ref`s, with the document its own local
 *  references resolve against. */
function deref(node: Schema, document: Schema, shapes: NamedShapeLookup): [Schema, Schema] {
  const reached = followSchemaReferences(node, document, shapes);
  return [reached.node, reached.document ?? document];
}

/** The schema a member name or list index reaches from `node`. */
export function schemaMemberOf(
  node: Schema,
  document: Schema,
  segment: DataToken,
  shapes: NamedShapeLookup,
): [Schema, Schema] | undefined {
  const [resolved, doc] = deref(node, document, shapes);
  if (typeof segment === "number" || /^(0|[1-9][0-9]*)$/.test(segment)) {
    if (isSchema(resolved.items)) return [resolved.items, doc];
    if (typeof segment === "number") return undefined;
  }
  const member = propertySchemas(resolved).find(([key]) => key === segment)?.[1];
  if (isSchema(member)) return [member, doc];
  for (const conjunct of Array.isArray(resolved.allOf) ? resolved.allOf : []) {
    if (!isSchema(conjunct)) continue;
    const found = schemaMemberOf(conjunct, doc, segment, shapes);
    if (found) return found;
  }
  return undefined;
}

/** The schema `root` declares at a data path, through lists and members. */
export function schemaAtData(root: Schema | undefined, tokens: readonly DataToken[], shapes: NamedShapeLookup): Schema | undefined {
  if (!root) return undefined;
  let node: Schema = root;
  let doc: Schema = root;
  for (const token of tokens) {
    const found = schemaMemberOf(node, doc, token, shapes);
    if (!found) return undefined;
    [node, doc] = found;
  }
  return deref(node, doc, shapes)[0];
}

/**
 * Why `rule`, on a binding (or member) of the region declared on the field at
 * `levels[levels.length - 1]`, names nothing the schema declares — or
 * undefined; with the target's schema when it names something. `rootIsResource`
 * says the document is a kind's schema rather than a named shape's.
 */
export function nullableWhenTarget(
  levels: readonly SchemaLevel[],
  rule: NullableWhen,
  document: Schema,
  shapes: NamedShapeLookup,
  rootIsResource: boolean,
): { refusal: string } | { target: Schema } {
  return holderPointerTarget(levels, rule.at, document, shapes, rootIsResource);
}

/**
 * The schema a relative pointer anchored at the context holder names, for a
 * binding (or member) of the region declared on the field at
 * `levels[levels.length - 1]` — or why it names nothing the schema declares.
 */
export function holderPointerTarget(
  levels: readonly SchemaLevel[],
  pointer: RelativePointer,
  document: Schema,
  shapes: NamedShapeLookup,
  rootIsResource: boolean,
): { refusal: string } | { target: Schema } {
  // A region on a list's items is held by the item itself.
  const field = levels.length - 1;
  const holderLevel = levels[field]?.key === "*" ? field : field - 1;
  const at = holderLevel - pointer.up;
  if (at < 0) {
    return {
      refusal: rootIsResource
        ? `it climbs ${pointer.up} level${pointer.up === 1 ? "" : "s"} from the context holder, above the resource`
        : `it climbs ${pointer.up} level${pointer.up === 1 ? "" : "s"} from the context holder, above the named shape, whose holder is not known here`,
    };
  }
  let node: Schema = levels[at]!.node;
  let doc = document;
  for (const segment of pointer.segments) {
    const found = schemaMemberOf(node, doc, segment, shapes);
    if (!found) return { refusal: `it names '${segment}', which the schema does not declare there` };
    [node, doc] = found;
  }
  return { target: deref(node, doc, shapes)[0] };
}

/** What `x-telo-context-nullable-when` reads: the value at `at`, from the
 *  object holding the region's field — the item, for a region on a list. */
export const nullableWhenReads: ReadReporter = ({ value, at, item }) => {
  const pointer = isSchema(value) && typeof value.at === "string" ? value.at : undefined;
  if (!pointer || !readRelativePointer(pointer)) return [];
  const seen = new Set<string>();
  const out: ReadPlace[] = [];
  for (const base of [enclosingKeys(at), item]) {
    const keys = placeAt(base, pointer);
    const id = JSON.stringify(keys);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: "value", keys });
  }
  return out;
};
