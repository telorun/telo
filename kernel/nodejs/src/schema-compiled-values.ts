import { isCompiledValue } from "@telorun/sdk";
import { type ExternalSchemaResolver, resolveRefIn, selectUnionBranch } from "@telorun/analyzer";

/** Returns a schema-appropriate placeholder value for a CompiledValue field. */
function placeholderForSchema(schema: Record<string, unknown>): unknown {
  if (schema.default !== undefined) return schema.default;
  // An enum-constrained field needs a placeholder drawn from the enum: the
  // type-based fallbacks below satisfy `type` but violate `enum`, so any CEL
  // expression feeding an enum field would fail validation against a value the
  // author never wrote. Mirrors `celPlaceholderForSchema` in the analyzer, which
  // performs the same substitution for the static half.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  // A union with no `type` of its own: take the first branch that yields a
  // placeholder, so a whole-field CEL leaf at an `anyOf` slot is not handed the
  // `""` fallback that only a string branch would accept. Mirrors the analyzer's
  // `celPlaceholderForSchema`, which makes the same substitution for the static
  // half — the two must agree or one rejects what the other passes.
  if (schema.type === undefined) {
    const branches = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (branch && typeof branch === "object") return placeholderForSchema(branch);
      }
    }
  }
  switch (schema.type) {
    case "integer":
    case "number":
      return (schema.minimum as number | undefined) ?? 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
}

/**
 * Resolve a `$ref` — document-local against `root`, everything else through the
 * schema store when the caller supplies one.
 *
 * Without the store a named shape (`telo:<module>/<Type>`) stops the walk: the
 * node reads as undescribed, so every CEL leaf beneath it collapses to `""` and
 * is then rejected by the very schema that describes it. A kind referencing a
 * shape declared elsewhere is exactly the case, and the failure surfaces as a
 * violation of a value the author never wrote.
 */
function resolveSchemaRef(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  external?: ExternalSchemaResolver,
): { schema: Record<string, unknown>; root: Record<string, unknown> } {
  return resolveRefIn(schema as Record<string, any>, root as Record<string, any>, external) as {
    schema: Record<string, unknown>;
    root: Record<string, unknown>;
  };
}

/** Collect property schemas from top-level `properties` and all `oneOf`/`anyOf` sub-schemas. */
function collectSchemaProperties(
  schema: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const props: Record<string, Record<string, unknown>> = {
    ...((schema.properties ?? {}) as Record<string, Record<string, unknown>>),
  };
  for (const sub of (schema.oneOf ?? schema.anyOf ?? []) as Record<string, unknown>[]) {
    if (sub && typeof sub === "object" && sub.properties) {
      for (const [k, v] of Object.entries(
        sub.properties as Record<string, Record<string, unknown>>,
      )) {
        if (!(k in props)) props[k] = v;
      }
    }
  }
  return props;
}

/** True when a ref slot is holding CONFIG rather than a reference.
 *
 *  A slot annotated `x-telo-ref` is normally handed back whole, but the
 *  annotation can sit on a node that is a reference AND a config carrier at
 *  once: `targets:` puts it on the array ITEM so a bare `!ref Foo` is accepted,
 *  while the same item may be a step object (`{ref, when}` /
 *  `{invoke, inputs, when}`) whose `when` is a CEL guard that must be stripped
 *  like any other. Told apart by what the value IS, three ways:
 *
 *  - a reference carries a `kind` — `resolveRefSentinels` rewrites a `!ref` to
 *    `{kind, name, alias?}`, and the only other object a ref slot admits is an
 *    inline definition (`{kind, …config}`);
 *  - a live instance is either not a plain object, or exposes a method (a
 *    controller's `create()` may return an object literal — `Assert.Schema`
 *    does). Copying one is what the walk exists to avoid, and its graph is
 *    routinely cyclic;
 *  - what is left came from YAML, where a function cannot appear. */
function isConfigAtRefSlot(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const obj = value as Record<string, unknown>;
  if ("kind" in obj) return false;
  for (const member of Object.values(obj)) {
    if (typeof member === "function") return false;
  }
  return true;
}

/** Replaces CompiledValue wrappers with schema-appropriate placeholders for schema validation.
 *  Template strings were compiled from YAML at load time; this restores a shape
 *  that AJV can validate without evaluating expressions. When no schema is
 *  supplied every compiled value collapses to `""` (the `default` branch of
 *  `placeholderForSchema`), matching the schema-unaware strip.
 *
 *  The walk stops short of anything that is not plain config, mirroring
 *  `buildResolvedProperties`: by the time a resource reaches validation its ref
 *  slots may already hold LIVE resource instances (a template passing the
 *  caller's client down with `client: !cel "self.client"` hands the child the
 *  injected instance, not a ref), and a controller's object graph is
 *  arbitrarily deep and routinely cyclic — walking one overflows the stack
 *  instead of producing a diagnostic, and there is nothing inside it to strip. */
export function stripCompiledValues(
  v: unknown,
  schema: Record<string, unknown> = {},
  rootSchema?: Record<string, unknown>,
  external?: ExternalSchemaResolver,
): unknown {
  const root = rootSchema ?? schema;
  // Ancestors on the current path, so a genuine cycle stops while a sub-object
  // that merely appears twice is still stripped both times.
  const ancestors = new Set<object>();

  const walk = (
    value: unknown,
    rawNodeSchema: Record<string, unknown>,
    base: Record<string, unknown> = root,
  ): unknown => {
    // A UNION carries no `type` / `items` / `properties` of its own, so descending
    // through one hands every CEL leaf underneath the schema-unaware `""`
    // placeholder — which the branches then reject, reporting violations against
    // a value the author never wrote (`/success/1 must be integer` for a `!cel`
    // inside a list). Resolving the branch first is what lets the leaves be
    // placed. Shared with the analyzer rather than reimplemented: the static and
    // dispatch halves must choose the same branch, or one reports what the other
    // accepts.
    const entered = resolveSchemaRef(rawNodeSchema, base, external);
    const nodeSchema = selectUnionBranch(
      entered.schema,
      value,
      entered.root as Record<string, any>,
      external,
    ) as Record<string, unknown>;
    const here = resolveSchemaRef(nodeSchema, entered.root, external);
    const resolved = here.schema;
    const nodeRoot = here.root;

    if (isCompiledValue(value)) return placeholderForSchema(resolved);
    // A slot the schema declares as a reference is never config when it HOLDS a
    // reference: a `{kind, name}` ref or the live instance Phase 5 replaced it
    // with, and the schema declares no shape to validate against either way. A
    // ref slot carrying config beside the ref keeps walking — bailing there left
    // a boot target's `when: !cel` a CompiledValue for AJV to reject as
    // "must be string", which is the whole gated-target form.
    if (resolved["x-telo-ref"] !== undefined && !isConfigAtRefSlot(value)) return value;

    if (Array.isArray(value)) {
      const item = resolveSchemaRef((resolved.items ?? {}) as Record<string, unknown>, nodeRoot, external);
      return walkGuarded(value, () =>
        value.map((element) => walk(element, item.schema, item.root)),
      );
    }
    if (value !== null && typeof value === "object") {
      // A class instance (a client, a pool, a stream) carries no CompiledValues
      // and is not described by the schema — copying it is pure risk.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;

      const props = collectSchemaProperties(resolved);
      return walkGuarded(value, () => {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
          out[k] = walk(val, props[k] ?? {}, nodeRoot);
        }
        return out;
      });
    }
    return value;
  };

  /** Runs `fn` with `node` marked as an ancestor; a node already on the path is
   *  a cycle and is returned as-is rather than recursed into. */
  const walkGuarded = (node: object, fn: () => unknown): unknown => {
    if (ancestors.has(node)) return node;
    ancestors.add(node);
    try {
      return fn();
    } finally {
      ancestors.delete(node);
    }
  };

  return walk(v, schema);
}
