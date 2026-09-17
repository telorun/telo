/**
 * **`x-telo-unbound-calls` — the annotation's single reader.**
 *
 * A field whose expressions the runtime evaluates where no module function is
 * bound: an Application's `logging:` block, resolved while the application loads
 * and before any resource exists, and a type rule's `condition`, evaluated
 * against the value alone wherever the shape is checked. A module call there
 * cannot reach a function, so it is refused where it is written instead of
 * failing at boot or at the first validation. The annotation's value is the
 * reason, quoted by the diagnostic, so nothing here knows which kinds carry one.
 *
 * It covers every expression beneath the node that carries it, through
 * `properties`, `additionalProperties`, `items` and every `oneOf` / `anyOf` /
 * `allOf` branch. On a `type: string` node it also says the field's plain text
 * IS an expression — a type rule's condition is written untagged and evaluated
 * as CEL source — so that text is read for calls too; below an object node a
 * plain string stays a literal.
 *
 * Browser-safe: no Node built-ins.
 */
import { isTaggedSentinel } from "@telorun/templating";
import { resolveLocalRef } from "./schema-walk.js";

export const UNBOUND_CALLS_ANNOTATION = "x-telo-unbound-calls";

type SchemaNode = Record<string, any>;

interface PathReading {
  /** The reason on the path, when any node along it carries one. */
  readonly reason?: string;
  /** Set when the node the path ENDS at carries the reason and declares a
   *  string: its plain text is an expression. */
  readonly source?: boolean;
}

const readingsBySchema = new WeakMap<object, Map<string, PathReading>>();
const declaresBySchema = new WeakMap<object, boolean>();

/**
 * The reason module calls are unbound at `path` (the `walkCelExpressions`
 * spelling, `rules[0].condition`) under `schema`, or undefined when a call there
 * is bound like any other.
 */
export function unboundCallReason(
  schema: SchemaNode | undefined,
  path: string,
): string | undefined {
  return schema && declaresUnboundCalls(schema) ? readingAt(schema, path).reason : undefined;
}

/** One plain-text expression in a field whose text is evaluated as CEL with no
 *  module function bound. */
export interface UnboundCallSource {
  readonly path: string;
  readonly source: string;
  readonly reason: string;
}

/** Every plain-text expression `manifest` holds where its schema says the text
 *  is evaluated as CEL with no module function bound. */
export function unboundCallSources(
  manifest: unknown,
  schema: SchemaNode | undefined,
): UnboundCallSource[] {
  if (!schema || !declaresUnboundCalls(schema)) return [];
  const out: UnboundCallSource[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const reading = readingAt(schema, path);
      if (reading.source && reading.reason !== undefined) {
        out.push({ path, source: value, reason: reading.reason });
      }
      return;
    }
    if (!value || typeof value !== "object" || isTaggedSentinel(value)) return;
    if ((value as { __compiled?: unknown }).__compiled === true) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
  };
  visit(manifest, "");
  return out;
}

function declaresUnboundCalls(schema: SchemaNode): boolean {
  let declares = declaresBySchema.get(schema);
  if (declares === undefined) {
    declares = holdsAnnotation(schema, new Set());
    declaresBySchema.set(schema, declares);
  }
  return declares;
}

/** Whether any object beneath `value` carries the annotation. Walked rather than
 *  serialized, so a schema holding a bigint default or a cycle is read instead of
 *  thrown on. */
function holdsAnnotation(value: unknown, seen: Set<object>): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, UNBOUND_CALLS_ANNOTATION)) {
    return true;
  }
  for (const child of Object.values(value)) if (holdsAnnotation(child, seen)) return true;
  return false;
}

function readingAt(root: SchemaNode, path: string): PathReading {
  let byPath = readingsBySchema.get(root);
  if (!byPath) readingsBySchema.set(root, (byPath = new Map()));
  let reading = byPath.get(path);
  if (!reading) {
    reading = readAlong(root, path);
    byPath.set(path, reading);
  }
  return reading;
}

function readAlong(root: SchemaNode, path: string): PathReading {
  let nodes = expand([root], root);
  for (const segment of segmentsOf(path)) {
    const reason = reasonOn(nodes);
    if (reason !== undefined) return { reason };
    const next: SchemaNode[] = [];
    for (const node of nodes) {
      if (typeof segment === "number") {
        if (isSchema(node.items)) next.push(node.items);
        continue;
      }
      const property = node.properties?.[segment];
      if (isSchema(property)) next.push(property);
      else if (isSchema(node.additionalProperties)) next.push(node.additionalProperties);
    }
    if (next.length === 0) return {};
    nodes = expand(next, root);
  }
  const reason = reasonOn(nodes);
  if (reason === undefined) return {};
  return {
    reason,
    source: nodes.some(
      (node) => typeof node[UNBOUND_CALLS_ANNOTATION] === "string" && node.type === "string",
    ),
  };
}

/** The nodes themselves plus every combinator branch beneath them, local
 *  references resolved. */
function expand(nodes: SchemaNode[], root: SchemaNode): SchemaNode[] {
  const out: SchemaNode[] = [];
  const seen = new Set<object>();
  const visit = (node: SchemaNode) => {
    const resolved = resolveLocalRef(node, root) ?? node;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
    for (const key of ["oneOf", "anyOf", "allOf"] as const) {
      const branches = resolved[key];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) if (isSchema(branch)) visit(branch);
    }
  };
  for (const node of nodes) visit(node);
  return out;
}

function reasonOn(nodes: SchemaNode[]): string | undefined {
  for (const node of nodes) {
    const reason = node[UNBOUND_CALLS_ANNOTATION];
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return undefined;
}

function segmentsOf(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    out.push(match[2] !== undefined ? Number(match[2]) : match[1]!);
  }
  return out;
}

function isSchema(value: unknown): value is SchemaNode {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
