/**
 * `x-telo-span-attribute: "<name>"` — the one reader of the annotation, shared by
 * `telo check` and the kernel.
 *
 * Written on a scalar property of an `inputType` / `outputType`, it puts that
 * property's value on the resource's dispatch span under `<name>` — the only way
 * a dispatch's data reaches an exported span, since a span otherwise never
 * carries inputs or outputs (`kernel/specs/tracing.md`).
 *
 * A mark is well-formed when its name follows the attribute grammar and is not
 * one the runtime sets itself, and it is well-PLACED when it names ONE value per
 * dispatch: a scalar property reached from the contract's root through
 * `properties` alone (a union branch at the same position counts, and a `$ref`
 * is followed), never through `items` / `additionalProperties` /
 * `patternProperties`, never the root itself, and never beside
 * `x-telo-sensitive: true` — a value marked as auth material does not go to a
 * trace backend.
 *
 * Browser-safe: no Node built-ins.
 */

import { isLiveSlot } from "@telorun/sdk";
import { resolveRefIn, type ExternalSchemaResolver } from "./schema-compat.js";

export const X_TELO_SPAN_ATTRIBUTE = "x-telo-span-attribute";

/** Dotted lowercase segments, the OpenTelemetry attribute-name convention
 *  (`gen_ai.usage.input_tokens`, `telo.check.exit_code`). */
const SPAN_ATTRIBUTE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_NAME_LENGTH = 255;

/** Names the runtime sets on a span itself, which a mark would collide with. */
export const RUNTIME_SPAN_ATTRIBUTES: readonly string[] = [
  "error.type",
  "telo.cancellation.reason",
  "telo.resource.kind",
  "telo.resource.name",
];

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean", "null"]);

export interface SpanAttributePath {
  /** Property names from the contract's root to the marked value. */
  path: string[];
  name: string;
}

/** Why a mark's VALUE is not a usable attribute name, or `undefined`. */
export function spanAttributeNameProblem(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return `'${X_TELO_SPAN_ATTRIBUTE}' must be an attribute name; got ${JSON.stringify(value)}`;
  }
  if (value.length > MAX_NAME_LENGTH || !SPAN_ATTRIBUTE_NAME.test(value)) {
    return (
      `'${X_TELO_SPAN_ATTRIBUTE}: ${JSON.stringify(value)}' is not an attribute name: write ` +
      `dot-separated lowercase segments of letters, digits and underscores, each starting ` +
      `with a letter (e.g. 'telo.check.exit_code'), at most ${MAX_NAME_LENGTH} characters`
    );
  }
  if (RUNTIME_SPAN_ATTRIBUTES.includes(value)) {
    return (
      `'${X_TELO_SPAN_ATTRIBUTE}: ${value}' names an attribute the runtime sets on every ` +
      `span itself (${RUNTIME_SPAN_ATTRIBUTES.join(", ")}); choose another name`
    );
  }
  return undefined;
}

/** Why the marked schema NODE cannot carry an attribute, or `undefined`. */
export function spanAttributeNodeProblem(node: Record<string, unknown>): string | undefined {
  if (node["x-telo-sensitive"] === true) {
    return (
      `'${X_TELO_SPAN_ATTRIBUTE}' sits beside 'x-telo-sensitive: true': a value marked as auth ` +
      `material is never exported to a trace backend. Remove one of the two marks`
    );
  }
  if (!isScalarNode(node)) {
    return (
      `'${X_TELO_SPAN_ATTRIBUTE}' must mark a scalar property (type string, integer, number or ` +
      `boolean); this node is ${describeNode(node)}`
    );
  }
  return undefined;
}

function isScalarNode(node: Record<string, unknown>): boolean {
  const type = node.type;
  if (typeof type === "string") return SCALAR_TYPES.has(type) && type !== "null";
  if (Array.isArray(type)) {
    return (
      type.length > 0 &&
      type.every((t) => typeof t === "string" && SCALAR_TYPES.has(t)) &&
      type.some((t) => t !== "null")
    );
  }
  if (type !== undefined) return false;
  const values = Array.isArray(node.enum) ? node.enum : "const" in node ? [node.const] : undefined;
  return (
    values !== undefined &&
    values.length > 0 &&
    values.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))
  );
}

function describeNode(node: Record<string, unknown>): string {
  if (node.type !== undefined) return `declared type ${JSON.stringify(node.type)}`;
  if (typeof node.$ref === "string") return `a reference ('${node.$ref}'), whose shape is not fixed here`;
  return "declared with no scalar type";
}

/** The problem of a mark a contract reaches at its root, or through an array
 *  item or a map value. */
export function spanAttributeReachProblem(reason: "root" | "collection"): string {
  return reason === "root"
    ? `'${X_TELO_SPAN_ATTRIBUTE}' marks the contract's whole value; mark one of its properties`
    : `the contract reaches an '${X_TELO_SPAN_ATTRIBUTE}' mark through this property's array ` +
        `item or map value, which holds any number of values per dispatch; a span attribute ` +
        `is one value — mark a property reached through 'properties' alone`;
}

export interface SpanAttributeProblem {
  code: "SPAN_ATTRIBUTE_INVALID" | "SPAN_ATTRIBUTE_MISPLACED";
  /** A problem of the mark itself, or of how the contract reaches it. */
  at: "mark" | "reach";
  /** The schema node the problem belongs to, as written: the mark's own node,
   *  or — for a mark the contract reaches at its root or through an array item
   *  or a map value — the property through which it does (the contract root
   *  for the root). */
  node: object;
  /** That node's property path from the contract root; empty for the root. */
  path: string[];
  message: string;
}

export interface SpanAttributeReading {
  attributes: SpanAttributePath[];
  problems: SpanAttributeProblem[];
  /** Every schema node, as written, whose own mark the walk reached. */
  reached: Set<object>;
}

/** `at 'turnId': …` — how the kernel names a problem in its refusal. */
export function describeSpanAttributeProblem(problem: SpanAttributeProblem): string {
  const at = problem.path.length === 0 ? "the contract root" : `'${problem.path.join(".")}'`;
  return `at ${at}: ${problem.message}`;
}

/**
 * Every mark a contract reaches, read by the kernel off the contract it binds
 * and by `telo check` off the same contract, so the two find the same problems.
 *
 * A mark is reached through `properties` alone — a union branch at the same
 * position counts — following `$ref` wherever it leads: a document-local
 * `$defs` entry (resolved against the document the reference sits in), a named
 * shape (through `resolveRef`, whose target becomes the document), and the
 * siblings beside a `$ref`, which override the target's. A live value is not
 * walked. Problems with the mark itself — its name, a non-scalar node, a node
 * beside `x-telo-sensitive: true` — belong to the mark; a mark reached at the
 * contract root or through an array item or a map value is a problem of the
 * property that reaches it, reported once per such property.
 */
export function spanAttributePaths(
  schema: Record<string, any>,
  resolveRef?: ExternalSchemaResolver,
): SpanAttributeReading {
  const attributes: SpanAttributePath[] = [];
  const problems: SpanAttributeProblem[] = [];
  const reached = new Set<object>();
  const reachReported = new Set<object>();

  interface Reach {
    node: object;
    path: string[];
  }

  const reachProblem = (reach: Reach, reason: "root" | "collection"): void => {
    if (reachReported.has(reach.node)) return;
    reachReported.add(reach.node);
    problems.push({
      code: "SPAN_ATTRIBUTE_MISPLACED",
      at: "reach",
      node: reach.node,
      path: reach.path,
      message: spanAttributeReachProblem(reason),
    });
  };

  const walk = (
    node: unknown,
    path: string[],
    root: Record<string, any>,
    // The property a collection was entered through, once one has been.
    collection: Reach | undefined,
    chain: readonly object[],
  ): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (chain.includes(node)) return;
    const written: object[] = [node];
    let s = node as Record<string, any>;
    let document = root;
    while (typeof s.$ref === "string") {
      const { schema: target, root: targetRoot } = resolveRefIn(s, document, resolveRef);
      if (target === s || written.includes(target) || chain.includes(target)) break;
      written.push(target);
      const siblings: Record<string, any> = { ...s };
      delete siblings.$ref;
      s = { ...target, ...siblings };
      document = targetRoot;
    }
    if (isLiveSlot(s)) return;
    const here = [...chain, ...written];

    const owner = written.find((o) => Object.hasOwn(o, X_TELO_SPAN_ATTRIBUTE));
    if (owner) {
      for (const o of written) if (Object.hasOwn(o, X_TELO_SPAN_ATTRIBUTE)) reached.add(o);
      const value = s[X_TELO_SPAN_ATTRIBUTE];
      const nameProblem = spanAttributeNameProblem(value);
      if (nameProblem) {
        problems.push({ code: "SPAN_ATTRIBUTE_INVALID", at: "mark", node: owner, path, message: nameProblem });
      }
      let placed = false;
      if (collection) reachProblem(collection, "collection");
      else if (path.length === 0) reachProblem({ node, path }, "root");
      else {
        const nodeProblem = spanAttributeNodeProblem(s);
        if (nodeProblem) {
          problems.push({ code: "SPAN_ATTRIBUTE_MISPLACED", at: "mark", node: owner, path, message: nodeProblem });
        } else placed = true;
      }
      if (placed && !nameProblem) attributes.push({ path, name: value as string });
    }

    const properties = s.properties as Record<string, any> | undefined;
    if (properties && typeof properties === "object") {
      for (const [key, child] of Object.entries(properties)) {
        walk(child, [...path, key], document, collection, here);
      }
    }
    for (const branch of ["allOf", "anyOf", "oneOf"] as const) {
      const list = s[branch];
      if (Array.isArray(list)) for (const child of list) walk(child, path, document, collection, here);
    }
    const entered = collection ?? { node, path };
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      walk(s.additionalProperties, [...path, "{}"], document, entered, here);
    }
    if (s.patternProperties && typeof s.patternProperties === "object") {
      for (const child of Object.values(s.patternProperties)) {
        walk(child, [...path, "{}"], document, entered, here);
      }
    }
    for (const child of [s.items].flat()) walk(child, [...path, "[]"], document, entered, here);
  };

  walk(schema, [], schema, undefined, []);
  return { attributes, problems, reached };
}
