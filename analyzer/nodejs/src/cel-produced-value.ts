/**
 * What an expression's value is known to be, read off its tree — the producer
 * half of the CEL slot-fit join for an expression that is not a plain chain.
 *
 * One reader, compositional: a plain chain is the schema its root declares at
 * its tail; a module call is its callee's declared `returns`; a literal is its
 * value; a list literal is its elements, each known to be in the list; a map
 * literal is the object holding exactly its literal keys; list `+` is the
 * elements of both operands; `?:` is either branch. Anything else claims
 * nothing, and an element or member that claims nothing is left out rather
 * than guessed at.
 *
 * Browser-safe: no Node built-ins.
 */
import { parseExpression, type CelNode } from "@telorun/cel";
import { checkSchemaCompatibility, type CompatibilityConflict } from "./schema-compat.js";

/** What is known about a value. `elements` is a list every one of whose listed
 *  shapes occurs in it; `either` is a value that is one of its alternatives. */
export type ProducedValue =
  | { readonly kind: "schema"; readonly schema: Record<string, any> }
  | { readonly kind: "elements"; readonly elements: readonly Record<string, any>[] }
  | { readonly kind: "either"; readonly alternatives: readonly ProducedValue[] };

/** What reading a producer needs from the site the expression is written at. */
export interface ProducedValueHost {
  /** The schema a plain chain's root declares at the chain's tail. */
  chainSchema(chain: string): Record<string, any> | undefined;
  /** The receivers a module call is written through at this site. */
  readonly moduleNames: ReadonlySet<string>;
  /** The declared `returns` of the module call `<receiver>.<name>`. */
  callResult(qualified: string): Record<string, any> | undefined;
  /** A named shape by id. */
  resolveRef(ref: string): Record<string, any> | undefined;
}

const PLAIN_CHAIN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** What `source` produces, or undefined when its tree says nothing. */
export function producedValueOf(source: string, host: ProducedValueHost): ProducedValue | undefined {
  const parsed = parseExpression(source);
  if (parsed.diagnostics.length > 0) return undefined;
  return produced(parsed.root, source, host);
}

function produced(node: CelNode, source: string, host: ProducedValueHost): ProducedValue | undefined {
  switch (node.kind) {
    case "literal": {
      const value = literalValue(node);
      return value === undefined ? undefined : { kind: "schema", schema: literalSchema(value.value) };
    }
    case "ident":
    case "select": {
      const text = source.slice(node.range[0], node.range[1]).trim();
      if (!PLAIN_CHAIN.test(text)) return undefined;
      const schema = host.chainSchema(text);
      return schema ? { kind: "schema", schema } : undefined;
    }
    case "receiverCall": {
      if (node.receiver.kind !== "ident" || !host.moduleNames.has(node.receiver.name)) return undefined;
      const schema = host.callResult(`${node.receiver.name}.${node.name}`);
      return schema ? { kind: "schema", schema } : undefined;
    }
    case "qcall": {
      if (!host.moduleNames.has(node.namespace)) return undefined;
      const schema = host.callResult(`${node.namespace}.${node.name}`);
      return schema ? { kind: "schema", schema } : undefined;
    }
    case "list":
      return {
        kind: "elements",
        elements: node.elements.flatMap((element) => {
          if (element.optional) return [];
          const schema = schemaOf(produced(element.value, source, host));
          return schema ? [schema] : [];
        }),
      };
    case "map": {
      const properties: Record<string, Record<string, any>> = {};
      const required: string[] = [];
      let closed = true;
      for (const entry of node.entries) {
        const key = entry.key.kind === "literal" ? literalValue(entry.key)?.value : undefined;
        if (typeof key !== "string") {
          closed = false;
          continue;
        }
        properties[key] = schemaOf(produced(entry.value, source, host)) ?? {};
        if (!entry.optional) required.push(key);
      }
      return {
        kind: "schema",
        schema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
          ...(closed ? { additionalProperties: false } : {}),
        },
      };
    }
    case "binary": {
      if (node.operator !== "+") return undefined;
      const left = elementsOf(produced(node.left, source, host), host);
      const right = elementsOf(produced(node.right, source, host), host);
      if (!left && !right) return undefined;
      return { kind: "elements", elements: [...(left ?? []), ...(right ?? [])] };
    }
    case "conditional": {
      const whenTrue = produced(node.whenTrue, source, host);
      const whenFalse = produced(node.whenFalse, source, host);
      return whenTrue && whenFalse ? { kind: "either", alternatives: [whenTrue, whenFalse] } : undefined;
    }
    default:
      return undefined;
  }
}

/** A literal as the schema holding exactly it, its JSON type beside it. */
function literalSchema(value: unknown): Record<string, any> {
  const type =
    value === null
      ? "null"
      : typeof value === "number"
        ? Number.isInteger(value)
          ? "integer"
          : "number"
        : typeof value === "boolean"
          ? "boolean"
          : "string";
  return { type, const: value };
}

/** A literal's JSON value, or undefined for one JSON has no form of. */
function literalValue(node: CelNode): { value: unknown } | undefined {
  if (node.kind !== "literal") return undefined;
  const literal = node.literal;
  switch (literal.type) {
    case "null":
      return { value: null };
    case "string":
    case "bool":
    case "double":
      return { value: literal.value };
    case "int":
    case "uint":
      return Number.isSafeInteger(Number(literal.value)) ? { value: Number(literal.value) } : undefined;
    default:
      return undefined;
  }
}

/** A producer as one JSON Schema, for a member or an element: a list's elements
 *  become an array of any of them, either branch an `anyOf`. */
function schemaOf(value: ProducedValue | undefined): Record<string, any> | undefined {
  if (!value) return undefined;
  switch (value.kind) {
    case "schema":
      return value.schema;
    case "elements":
      return value.elements.length > 0
        ? { type: "array", items: { anyOf: value.elements } }
        : { type: "array" };
    case "either": {
      const branches = value.alternatives.map(schemaOf);
      return branches.every((b): b is Record<string, any> => b !== undefined)
        ? { anyOf: branches }
        : undefined;
    }
  }
}

/** The element shapes a `+` operand contributes: a list's elements, or the
 *  declared `items` of an array an operand reads. */
function elementsOf(
  value: ProducedValue | undefined,
  host: ProducedValueHost,
): readonly Record<string, any>[] | undefined {
  if (!value) return undefined;
  if (value.kind === "elements") return value.elements;
  if (value.kind !== "schema") return undefined;
  const schema = deref(value.schema, host.resolveRef);
  const items = schema.items;
  return items && typeof items === "object" && !Array.isArray(items) ? [items] : undefined;
}

function deref(
  schema: Record<string, any>,
  resolveRef: (ref: string) => Record<string, any> | undefined,
): Record<string, any> {
  let current = schema;
  for (let hops = 0; hops < 16 && typeof current.$ref === "string"; hops++) {
    const next = resolveRef(current.$ref);
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * Why `value` cannot be what `target` declares — definite conflicts only — or
 * none when it can. Each element of a list must fit the target's `items`; a
 * value that is one of several alternatives fits when one does, as a union
 * target fits when one of its branches does. A conflict says whether it lies
 * beneath a value type's type argument, as the comparator reports it.
 */
export function producedValueMisfits(
  value: ProducedValue,
  target: Record<string, any>,
  resolveRef: (ref: string) => Record<string, any> | undefined,
): CompatibilityConflict[] {
  const compatible = (source: Record<string, any>, slot: Record<string, any>) =>
    checkSchemaCompatibility(conjoined(source, resolveRef), conjoined(slot, resolveRef), resolveRef, undefined, {
      targetFillsDefaults: true,
    }).conflicts;
  switch (value.kind) {
    case "schema":
      return compatible(value.schema, target);
    case "either": {
      const misfits = value.alternatives.map((alternative) =>
        producedValueMisfits(alternative, target, resolveRef),
      );
      return misfits.some((m) => m.length === 0) ? [] : misfits.flat();
    }
    case "elements": {
      const slot = deref(target, resolveRef);
      const branches = Array.isArray(slot.anyOf) ? slot.anyOf : Array.isArray(slot.oneOf) ? slot.oneOf : undefined;
      if (branches) {
        const misfits = branches.map((branch: Record<string, any>) =>
          producedValueMisfits(value, branch, resolveRef),
        );
        return misfits.some((m: CompatibilityConflict[]) => m.length === 0) ? [] : misfits.flat();
      }
      const items = slot.items;
      if (!items || typeof items !== "object" || Array.isArray(items)) return [];
      return value.elements.flatMap((element) => compatible(element, items));
    }
  }
}

/** Union keywords whose branches a node's own keywords hold beside. */
const UNION_KEYS = ["anyOf", "oneOf"] as const;

/**
 * `schema` with every union whose node declares keywords beside it read as
 * the union of those keywords conjoined with each branch — what such a node
 * means, and the form the comparison reads a branch in, since it reads a
 * branch alone. Named shapes are followed, once each per path; a branch's
 * property replaces the node's of the same name keyword by keyword, and
 * `required` lists join.
 */
function conjoined(
  schema: Record<string, any>,
  resolveRef: (ref: string) => Record<string, any> | undefined,
  open: ReadonlySet<string> = new Set(),
): Record<string, any> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  let node = schema;
  let path = open;
  if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
    if (open.has(node.$ref)) return node;
    const target = resolveRef(node.$ref);
    if (!target) return node;
    path = new Set(open).add(node.$ref);
    const { $ref: _ref, ...rest } = node;
    node = Object.keys(rest).length > 0 ? { ...target, ...rest } : target;
  }
  const walk = (child: unknown) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? conjoined(child as Record<string, any>, resolveRef, path)
      : child;
  const out: Record<string, any> = { ...node };
  if (out.properties && typeof out.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
    );
  }
  if (out.items && typeof out.items === "object" && !Array.isArray(out.items)) out.items = walk(out.items);
  if (out.additionalProperties && typeof out.additionalProperties === "object") {
    out.additionalProperties = walk(out.additionalProperties);
  }
  for (const key of UNION_KEYS) {
    const branches = out[key];
    if (!Array.isArray(branches)) continue;
    const { [key]: _union, ...base } = out;
    const hasBase = Object.keys(base).length > 0;
    return {
      [key]: branches.map((branch: unknown) => {
        const read = walk(branch) as Record<string, any>;
        return hasBase && read && typeof read === "object" ? merged(base, read) : read;
      }),
    };
  }
  return out;
}

function merged(base: Record<string, any>, branch: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base, ...branch };
  if (base.properties || branch.properties) {
    const properties: Record<string, any> = { ...(base.properties ?? {}) };
    for (const [key, value] of Object.entries((branch.properties ?? {}) as Record<string, any>)) {
      const own = properties[key];
      properties[key] =
        value && typeof value === "object" && own && typeof own === "object" ? { ...own, ...value } : value;
    }
    out.properties = properties;
  }
  if (Array.isArray(base.required) || Array.isArray(branch.required)) {
    out.required = [...new Set([...(base.required ?? []), ...(branch.required ?? [])])];
  }
  return out;
}
