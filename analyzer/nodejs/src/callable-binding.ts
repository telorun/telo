/**
 * **How a positional call becomes a callable's named arguments** — shared by the
 * kernel's dispatch entry and the analyzer's evaluation of a function body a rule
 * condition calls, so the two hand a body exactly the same values.
 *
 * A call site is positional and a callable receives one object keyed by
 * parameter name, mapped through the signature in force. An omitted optional
 * parameter takes its schema's `default`, and `null` when it declares none. Each
 * argument, each default and the result are normalized to the scalars their
 * schemas declare with exact conversions only — the rule a contract output
 * follows — so a CEL int crosses a `number` parameter or result as the double
 * both sides were typed against. A count the parameter list does not accept is a
 * refusal, never a truncation or padding.
 *
 * Browser-safe: no Node built-ins.
 */
import {
  signatureSchemaOf,
  type SignatureParam,
  type SignatureResult,
} from "./callable-signature.js";
import { declaredScalarPaths, normalizeDeclaredScalars } from "./invocation-contract.js";

/** Resolves a type reference to the schema it names. */
export type ShapeResolver = (ref: string) => Record<string, any> | undefined;

export interface ArityRefusal {
  readonly expected: number;
  readonly required: number;
  readonly message: string;
}

export interface CallArgumentBinding {
  /** Why a call passing `count` arguments cannot be made, or undefined. */
  arityRefusal(count: number): ArityRefusal | undefined;
  /** The named arguments for an accepted positional list. */
  bind(args: readonly unknown[]): Record<string, unknown>;
  /** An accepted positional list keyed by parameter name, exactly as passed —
   *  what a caller hands a function that binds its own arguments. */
  name(args: readonly unknown[]): Record<string, unknown>;
  /** The same, for arguments already keyed by name — what a holder passes to
   *  `call(args)`. An optional parameter it omits (or passes as `undefined`)
   *  takes its default; an omitted required one stays absent, and names the
   *  signature does not declare are kept, both for validation to judge. */
  bindNamed(args: Record<string, unknown>): Record<string, unknown>;
  /** The callable's result, in the representation its signature declares. */
  result(value: unknown): unknown;
}

export function callArgumentBinding(
  qualified: string,
  params: readonly SignatureParam[] | undefined,
  returns: SignatureResult | undefined,
  resolveRef: ShapeResolver,
): CallArgumentBinding {
  const declared = (params ?? []).map((param, index) => ({
    name: typeof param.name === "string" ? param.name : `#${index}`,
    optional: param.optional === true,
    schema: param.schema,
    scalars: scalarNormalizer(signatureSchemaOf(param), resolveRef),
  }));
  const normalizeResult = scalarNormalizer(signatureSchemaOf(returns), resolveRef);
  const required = declared.filter((param) => !param.optional).length;
  const defaults = new Map<number, unknown>();
  // A copy per call: a function that mutates a default it was handed must not
  // change what the next call, or the schema, holds.
  const defaultAt = (index: number): unknown => {
    if (!defaults.has(index)) defaults.set(index, defaultOf(declared[index]!.schema, resolveRef));
    return copyContainers(defaults.get(index));
  };

  return {
    arityRefusal(count) {
      if (count >= required && count <= declared.length) return undefined;
      const expected =
        required === declared.length ? `${required}` : `${required} to ${declared.length}`;
      return {
        expected: declared.length,
        required,
        message:
          `Function '${qualified}' takes ${expected} argument(s) ` +
          `(${declared.map((p) => (p.optional ? `${p.name}?` : p.name)).join(", ") || "none"}), ` +
          `and the call passes ${count}.`,
      };
    },
    bind(args) {
      const named: Record<string, unknown> = {};
      declared.forEach((param, index) => {
        named[param.name] = index < args.length ? param.scalars(args[index]) : defaultAt(index);
      });
      return named;
    },
    name(args) {
      const named: Record<string, unknown> = {};
      declared.forEach((param, index) => {
        if (index < args.length) named[param.name] = args[index];
      });
      return named;
    },
    bindNamed(args) {
      const named: Record<string, unknown> = { ...args };
      declared.forEach((param, index) => {
        const given = args[param.name];
        if (given !== undefined) named[param.name] = param.scalars(given);
        else if (param.optional) named[param.name] = defaultAt(index);
        else delete named[param.name];
      });
      return named;
    },
    result: normalizeResult,
  };
}

function defaultOf(schema: unknown, resolveRef: ShapeResolver): unknown {
  if (!schema || typeof schema !== "object") return null;
  const node = schema as Record<string, any>;
  const target =
    "default" in node ? node : typeof node.$ref === "string" ? resolveRef(node.$ref) : undefined;
  if (!target || !("default" in target)) return null;
  return scalarNormalizer(node, resolveRef)(target.default);
}

/** A default is JSON read from a schema, so its containers are arrays and plain
 *  objects; every leaf is immutable. */
function copyContainers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyContainers);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, copyContainers(item)]),
    );
  }
  return value;
}

function scalarNormalizer(
  schema: Record<string, any> | undefined,
  resolveRef: ShapeResolver,
): (value: unknown) => unknown {
  if (!schema) return (value) => value;
  const paths = declaredScalarPaths({ type: "object", properties: { value: schema } }, resolveRef);
  if (paths.length === 0) return (value) => value;
  return (value) => (normalizeDeclaredScalars({ value }, paths) as { value: unknown }).value;
}
