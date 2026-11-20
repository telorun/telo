/**
 * **A schema `default:` read as the value it stands for.**
 *
 * A default is text the kind's author wrote, so at a slot whose value type is held as an
 * instance (a URL, a duration, a timestamp) it is decoded exactly as the same literal
 * written in a manifest is — by the one decoding walk — never handed over as raw text.
 * AJV's `useDefaults` cannot do that: it writes the JSON literal, which the value-type
 * assertion then refuses. So such a default is filled, decoded, before AJV runs, at the
 * positions AJV would fill it (`properties` and object `items`, through `$ref` and
 * `allOf`; never inside `anyOf`, `oneOf`, `not` or `if`, which AJV ignores), and AJV finds
 * the property present. Every other default is left to AJV.
 *
 * A default whose text does not decode is filled as written, and the assertion refuses it
 * naming the form, as it refuses such a literal. A json-represented type (a host path, a
 * port) needs nothing: its text is its value. Browser-safe.
 */
import { isCelRecord, isCompiledValue, isInstanceSlot } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import { decodePlainLiterals } from "./plain-literal-decoding.js";
import { resolveRefIn, type ExternalSchemaResolver } from "./schema-compat.js";

/** A schema node with the document its local references resolve against. */
interface SchemaPart {
  readonly schema: Record<string, any>;
  readonly root: Record<string, any>;
}

const isSchemaObject = (node: unknown): node is Record<string, any> =>
  !!node && typeof node === "object" && !Array.isArray(node);

/** A schema `default:` as a fresh value: a copy of what is written, its plain-encoded
 *  literals decoded against the node declaring it. */
export function decodedSchemaDefault(
  node: Record<string, any>,
  external?: ExternalSchemaResolver,
  root: Record<string, any> = node,
): unknown {
  return decodePlainLiterals(structuredClone(node.default), node, external, root);
}

/**
 * What fills a value's instance-typed defaults, in place — or undefined when `schema`
 * declares none, so a caller holding it pays nothing per value. Built once per schema;
 * what it reads of each node is remembered by the filler.
 */
export function valueTypeDefaultFiller(
  schema: Record<string, any>,
  external?: ExternalSchemaResolver,
): ((value: unknown) => void) | undefined {
  // The node itself, its `$ref` target and its `allOf` members: every part whose
  // `properties` / `items` AJV fills a value at this position from.
  const expanded = new Map<object, SchemaPart[]>();
  const expand = (start: SchemaPart): SchemaPart[] => {
    const memo = expanded.get(start.schema);
    if (memo) return memo;
    const parts: SchemaPart[] = [];
    const seen = new Set<object>();
    const visit = (part: SchemaPart): void => {
      if (seen.has(part.schema)) return;
      seen.add(part.schema);
      parts.push(part);
      if (typeof part.schema.$ref === "string") {
        const target = resolveRefIn(part.schema, part.root, external);
        if (target.schema !== part.schema) visit(target);
      }
      for (const member of Array.isArray(part.schema.allOf) ? part.schema.allOf : []) {
        if (isSchemaObject(member)) visit({ schema: member, root: part.root });
      }
    };
    visit(start);
    expanded.set(start.schema, parts);
    return parts;
  };

  // Whether a node's subtree holds a value type held as an instance, anywhere a
  // decoding walk reaches: a default there has something to decode.
  const holdsInstance = reachability((part) => {
    const s = part.schema;
    const children: unknown[] = [
      ...Object.values(isSchemaObject(s.properties) ? s.properties : {}),
      ...Object.values(isSchemaObject(s.patternProperties) ? s.patternProperties : {}),
      s.items,
      s.additionalProperties,
      ...(["allOf", "anyOf", "oneOf"] as const).flatMap((key) => (Array.isArray(s[key]) ? s[key] : [])),
    ];
    const next = children.filter(isSchemaObject).map((child) => ({ schema: child, root: part.root }));
    if (typeof s.$ref === "string") {
      const target = resolveRefIn(s, part.root, external);
      if (target.schema !== s) next.push(target);
    }
    return { found: isInstanceSlot(s), next };
  });

  // Whether filling beneath a node can write an instance-typed default.
  const fillsBeneath = reachability((part) => {
    const next: SchemaPart[] = [];
    let found = false;
    for (const { schema: s, root } of expand(part)) {
      for (const child of isSchemaObject(s.properties) ? Object.values(s.properties) : []) {
        if (!isSchemaObject(child)) continue;
        const at = { schema: child, root };
        if ("default" in child && holdsInstance(at)) found = true;
        next.push(at);
      }
      if (isSchemaObject(s.items)) next.push({ schema: s.items, root });
    }
    return { found, next };
  });

  const top: SchemaPart = { schema, root: schema };
  if (!fillsBeneath(top)) return undefined;

  const fill = (value: unknown, part: SchemaPart): void => {
    if (!value || typeof value !== "object" || isCompiledValue(value) || isTaggedSentinel(value)) return;
    const parts = expand(part);
    if (Array.isArray(value)) {
      for (const { schema: s, root } of parts) {
        if (!isSchemaObject(s.items)) continue;
        const items: SchemaPart = { schema: s.items, root };
        if (fillsBeneath(items)) for (const item of value) fill(item, items);
      }
      return;
    }
    if (!isCelRecord(value)) return;
    const record = value as Record<string, unknown>;
    for (const { schema: s, root } of parts) {
      if (!isSchemaObject(s.properties)) continue;
      for (const [key, child] of Object.entries(s.properties)) {
        if (!isSchemaObject(child)) continue;
        const at: SchemaPart = { schema: child, root };
        if (record[key] === undefined && "default" in child && holdsInstance(at)) {
          record[key] = decodedSchemaDefault(child, external, root);
        }
        if (record[key] !== undefined && fillsBeneath(at)) fill(record[key], at);
      }
    }
  };
  return (value) => fill(value, top);
}

/**
 * Whether some node reachable from the one asked — through what `step` names next —
 * is one `step` finds. A whole search per node asked, remembered by node, so a recursive
 * schema is answered exactly rather than cut at its cycle.
 */
function reachability(
  step: (part: SchemaPart) => { readonly found: boolean; readonly next: readonly SchemaPart[] },
): (part: SchemaPart) => boolean {
  const answers = new Map<object, boolean>();
  return (start) => {
    const known = answers.get(start.schema);
    if (known !== undefined) return known;
    const seen = new Set<object>();
    const pending: SchemaPart[] = [start];
    let reached = false;
    while (pending.length > 0 && !reached) {
      const part = pending.pop()!;
      if (seen.has(part.schema)) continue;
      seen.add(part.schema);
      const answered = answers.get(part.schema);
      if (answered !== undefined) {
        reached = answered;
        continue;
      }
      const { found, next } = step(part);
      reached = found;
      pending.push(...next);
    }
    answers.set(start.schema, reached);
    return reached;
  };
}
