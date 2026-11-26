/**
 * `x-telo-context-ref-from: "<path>" | ["<path>", …]` — a node of an
 * `x-telo-context` typed from what a reference on the object holding the region
 * names. A path is read from that object as data until it reaches a reference
 * slot, crosses each slot into the declaration it names, and reads the field it
 * ends on there. A list holds ordered alternatives: the first that names
 * something types the node, and no later one is read.
 *
 * A path NAMES NOTHING where a segment before its last crossed slot holds
 * nothing — which segments are slots is the declaring kind's schema. It names
 * something where every segment through that slot holds a value, the field read
 * at the end included or not; a crossing that cannot be followed (a computed
 * value, a declaration outside the analysis, a library's kind-only input) reads
 * as unknown. The typing is `validate-cel-context.ts`'s; this file is the one
 * reader of the value, of the slot positions a path crosses, and of its strict
 * half (`validate-match-for.ts` reports it). Analyzer-only: the kernel reads no
 * context.
 *
 * Browser-safe: no Node built-ins.
 */
import { isRefSlot } from "./ref-slot.js";
import { followSchemaReferences, type NamedShapeLookup } from "./schema-reference.js";

export const CONTEXT_REF_FROM = "x-telo-context-ref-from";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema =>
  !!node && typeof node === "object" && !Array.isArray(node);

/** The ordered paths the annotation's value names, each as its segments, or
 *  undefined when the value is malformed. */
export function refFromPaths(value: unknown): readonly (readonly string[])[] | undefined {
  const written = typeof value === "string" ? [value] : Array.isArray(value) && value.length > 0 ? value : undefined;
  if (!written) return undefined;
  const paths: string[][] = [];
  for (const path of written) {
    if (typeof path !== "string") return undefined;
    const segments = path.split("/");
    if (segments.some((segment) => segment === "")) return undefined;
    paths.push(segments);
  }
  return paths;
}

/** Why the annotation's value is malformed, as the end of a sentence about it,
 *  or undefined. */
export function refFromValueProblem(value: unknown): string | undefined {
  return refFromPaths(value)
    ? undefined
    : "it must be a path ('target/schema/model'), or a non-empty list of them read as ordered alternatives, each segment non-empty";
}

/** A schema node read through its `$ref`s, with the document its own local
 *  references resolve against. */
function deref(node: Schema, document: Schema, shapes: NamedShapeLookup | undefined): [Schema, Schema] {
  const reached = followSchemaReferences(node, document, shapes);
  return [reached.node, reached.document ?? document];
}

/** Every schema a member name or list index reaches from `node`, in any branch. */
function membersOf(
  node: Schema,
  document: Schema,
  segment: string,
  shapes: NamedShapeLookup | undefined,
  seen = new Set<object>(),
): Array<[Schema, Schema]> {
  const [resolved, doc] = deref(node, document, shapes);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  const out: Array<[Schema, Schema]> = [];
  if (/^(0|[1-9][0-9]*)$/.test(segment) && isSchema(resolved.items)) out.push([resolved.items, doc]);
  if (isSchema(resolved.properties) && isSchema(resolved.properties[segment])) {
    out.push([resolved.properties[segment], doc]);
  }
  if (isSchema(resolved.patternProperties)) {
    for (const [pattern, member] of Object.entries(resolved.patternProperties as Schema)) {
      if (isSchema(member) && new RegExp(pattern, "u").test(segment)) out.push([member, doc]);
    }
  }
  if (isSchema(resolved.additionalProperties) && !(isSchema(resolved.properties) && segment in resolved.properties)) {
    out.push([resolved.additionalProperties, doc]);
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    for (const branch of Array.isArray(resolved[key]) ? resolved[key] : []) {
      if (isSchema(branch)) out.push(...membersOf(branch, doc, segment, shapes, seen));
    }
  }
  return out;
}

/** Whether any of `nodes` declares a reference slot, through its `$ref`s. */
function holdsSlot(nodes: ReadonlyArray<[Schema, Schema]>, shapes: NamedShapeLookup | undefined): boolean {
  return nodes.some(([node, doc]) => isRefSlot(node) || isRefSlot(deref(node, doc, shapes)[0]));
}

/**
 * Whether `segments`, read from `schema`, reach a reference slot at an index
 * from `from` up to the second-to-last — a slot the path would cross. A segment
 * the schema does not declare ends the reading: what follows is data.
 */
export function crossesSlotFrom(
  schema: Schema,
  segments: readonly string[],
  from: number,
  shapes: NamedShapeLookup | undefined,
): boolean {
  let nodes: Array<[Schema, Schema]> = [[schema, schema]];
  for (let i = 0; i < segments.length - 1; i++) {
    nodes = nodes.flatMap(([node, doc]) => membersOf(node, doc, segments[i]!, shapes));
    if (nodes.length === 0) return false;
    if (i >= from && holdsSlot(nodes, shapes)) return true;
  }
  return false;
}

/**
 * Why `segments`, read from `holder` — the schema of the object holding the
 * region — are no path the annotation can follow, or undefined. The segments up
 * to and including the first reference slot must each be declared there, in any
 * branch, and the path must go on past that slot; what lies beyond it is the
 * named declaration's and is not judged here.
 */
export function refFromHolderProblem(
  holder: Schema,
  document: Schema,
  segments: readonly string[],
  shapes: NamedShapeLookup | undefined,
): string | undefined {
  let nodes: Array<[Schema, Schema]> = [[holder, document]];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    nodes = nodes.flatMap(([node, doc]) => membersOf(node, doc, segment, shapes));
    const written = segments.slice(0, i + 1).join("/");
    if (nodes.length === 0) {
      return `'${written}' names nothing the object holding the region declares`;
    }
    if (holdsSlot(nodes, shapes)) {
      return i === segments.length - 1
        ? `'${written}' is a reference slot and the path ends there, so it names no field of the declaration the slot names`
        : undefined;
    }
  }
  return "it crosses no reference slot, so it names no declaration to read a field of";
}
