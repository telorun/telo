import { isTaggedSentinel } from "@telorun/templating";
import { decodePlainText, isCompiledValue } from "@telorun/sdk";
import {
  collectProperties,
  type ExternalSchemaResolver,
  resolveRefIn,
  selectUnionBranch,
  substituteCelFields,
  type SubstituteOptions,
} from "./schema-compat.js";

/**
 * Decode, IN PLACE, every string literal a resource's config writes at a slot
 * whose value type declares a plain encoding — a timestamp as RFC 3339 text,
 * bytes as base64url — into the instance the slot holds.
 *
 * A YAML literal is one of the places a value arrives from outside Telo, so it
 * is the one place such text is read; the slot holds the instance everywhere
 * else. Text the encoding does not accept is left as written, and the value-type
 * assertion that runs next refuses it, naming the form. Shared by the kernel at
 * resource creation and by `telo check` before validating a resource, so both
 * choose the same union branch, stop at the same reference slots and decode the
 * same leaves.
 *
 * The walk descends only plain containers: a compiled expression, a tagged
 * sentinel and a live instance are not literals, and a reference slot holds a
 * reference. Idempotent — a decoded leaf is no longer a string.
 */
export function decodePlainLiterals(
  value: unknown,
  schema: Record<string, any>,
  external?: ExternalSchemaResolver,
  rootSchema: Record<string, any> = schema,
): unknown {
  const walk = (node: unknown, raw: Record<string, any>, base: Record<string, any>): unknown => {
    const entered = resolveRefIn(raw, base, external);
    const selected = selectUnionBranch(entered.schema, node, entered.root, external);
    const { schema: here, root } = resolveRefIn(selected, entered.root, external);

    if (typeof node === "string") return decodePlainText(here, node);
    if (!node || typeof node !== "object") return node;
    if (here["x-telo-ref"] !== undefined) return node;
    if (isCompiledValue(node) || isTaggedSentinel(node)) return node;

    if (Array.isArray(node)) {
      const item = resolveRefIn((here.items ?? {}) as Record<string, any>, root, external);
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i], item.schema, item.root);
      return node;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node;
    const properties = collectProperties(here);
    const additional =
      here.additionalProperties && typeof here.additionalProperties === "object"
        ? (here.additionalProperties as Record<string, any>)
        : undefined;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = properties[key] ?? additional;
      if (child) record[key] = walk(record[key], child, root);
    }
    return node;
  };
  return walk(value, schema, rootSchema);
}

/**
 * {@link substituteCelFields} over `data` as the kernel reads it at a site it
 * decodes — a resource's own config, a slot the derived-slot reader enumerates:
 * its plain-encoded literals decoded first, by the one decoding walk the kernel
 * runs, on a copy, so the caller's manifest is left as written. Decoding is a
 * property of the SITE, so a caller at any other site (a definition's `result:`
 * mapping, which the kernel never decodes) substitutes without it.
 */
export function substituteDecodedCelFields(
  data: unknown,
  schema: Record<string, any>,
  rootSchema: Record<string, any> | undefined,
  options: SubstituteOptions = {},
): unknown {
  const decoded = decodePlainLiterals(
    copyPlainContainers(data),
    schema,
    options.external,
    rootSchema ?? schema,
  );
  return substituteCelFields(decoded, schema, rootSchema, options);
}

/** Arrays and plain objects copied, every other value shared — the containers
 *  decoding writes into. */
function copyPlainContainers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyPlainContainers);
  if (!value || typeof value !== "object" || isCompiledValue(value) || isTaggedSentinel(value)) {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      copyPlainContainers(item),
    ]),
  );
}
