/**
 * **A declared schema read as the shape it names.**
 *
 * A `$ref` says nothing by itself: a reader that stops at one sees an untyped
 * node, so a nullable or mistyped value behind it is judged as if nothing were
 * declared. Every judgment of the CEL value/slot join reads a schema through
 * this module instead — the producer's at each hop of its chain and at its tail,
 * the slot's at its leaf and in its union branches.
 *
 * Two kinds of reference, two resolutions:
 *
 *  - a NAMED SHAPE (`telo:<module>/<Type>`) through the registry the caller
 *    supplies; what lies beneath it is that shape's own document;
 *  - a DOCUMENT-LOCAL pointer (`#/$defs/Row`) against the document that DECLARES
 *    it. A CEL context is assembled from declared documents embedded whole (a
 *    step's `result` IS its target's outputType, a named shape is inlined where
 *    it was referenced), so the declaring document is the nearest enclosing node
 *    at which the pointer resolves — never the assembled root, under which two
 *    producers may each declare the same `$defs` name differently.
 *
 * A reference already being expanded is left as written, which keeps a
 * recursive shape finite and reads as a node that says nothing.
 */
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { REFERENCE_KEYS, type ExternalSchemaResolver } from "./schema-compat.js";

type Schema = Record<string, any>;

/** A schema node with the nodes enclosing it, outermost first, itself last. */
interface Entered {
  schema: Schema;
  enclosing: readonly Schema[];
}

const SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
]);
const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set(["properties", "patternProperties"]);
const SCHEMA_LIST_KEYS: ReadonlySet<string> = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const VALUE_TYPE_KEY = "x-telo-type";

const isSchema = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The schema nodes directly beneath `node`. A value type's object form carries
 *  its type arguments as schema nodes too. */
function childSchemas(node: Schema): Schema[] {
  const out: Schema[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_KEYS.has(key)) {
      if (Array.isArray(value)) out.push(...value.filter(isSchema));
      else if (isSchema(value)) out.push(value);
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      out.push(...value.filter(isSchema));
    } else if ((SCHEMA_MAP_KEYS.has(key) || key === VALUE_TYPE_KEY) && isSchema(value)) {
      out.push(...Object.values(value).filter(isSchema));
    }
  }
  return out;
}

const referenceBeneath = new WeakMap<Schema, boolean>();

/** True when `node`, or any schema beneath it, is a reference. */
function holdsReference(node: Schema): boolean {
  const known = referenceBeneath.get(node);
  if (known !== undefined) return known;
  const holds = typeof node.$ref === "string" || childSchemas(node).some(holdsReference);
  referenceBeneath.set(node, holds);
  return holds;
}

/** What the reference at `node` names, with the nodes enclosing THAT — or
 *  undefined when it names nothing this can resolve. */
function referenced(
  node: Schema,
  enclosing: readonly Schema[],
  external: ExternalSchemaResolver | undefined,
): Entered | undefined {
  const ref = node.$ref as string;
  if (!ref.startsWith("#")) {
    const target = external?.(ref);
    return target ? { schema: target, enclosing: [target] } : undefined;
  }
  const candidates = [...enclosing, node];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const target = resolveSchemaPointer(candidates[i]!, ref);
    if (!isSchema(target)) continue;
    const declaring = candidates.slice(0, i + 1);
    return { schema: target, enclosing: target === candidates[i] ? declaring : [...declaring, target] };
  }
  return undefined;
}

/** `node` with every reference it IS followed; what it holds beneath is left. */
function enter(
  node: Schema,
  enclosing: readonly Schema[],
  external: ExternalSchemaResolver | undefined,
): Entered {
  let at: Entered = { schema: node, enclosing: [...enclosing, node] };
  const followed = new Set<Schema>();
  while (typeof at.schema.$ref === "string" && !followed.has(at.schema)) {
    followed.add(at.schema);
    const next = referenced(at.schema, at.enclosing.slice(0, -1), external);
    if (!next) break;
    at = next;
  }
  return at;
}

function expand(
  node: unknown,
  enclosing: readonly Schema[],
  external: ExternalSchemaResolver | undefined,
  open: ReadonlySet<Schema>,
): unknown {
  if (!isSchema(node) || !holdsReference(node)) return node;
  if (typeof node.$ref === "string") {
    const target = referenced(node, enclosing, external);
    if (!target || open.has(target.schema)) return node;
    const named = expand(
      target.schema,
      target.enclosing.slice(0, -1),
      external,
      new Set(open).add(target.schema),
    ) as Schema;
    // The reference's own keys go; a `title` or `description` beside it stays.
    const siblings = Object.entries(node).filter(([key]) => !REFERENCE_KEYS.has(key));
    return siblings.length === 0 ? named : { ...named, ...Object.fromEntries(siblings) };
  }
  const here = [...enclosing, node];
  const beneath = (value: unknown) => expand(value, here, external, open);
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_KEYS.has(key)) {
      out[key] = Array.isArray(value) ? value.map(beneath) : beneath(value);
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      out[key] = value.map(beneath);
    } else if ((SCHEMA_MAP_KEYS.has(key) || key === VALUE_TYPE_KEY) && isSchema(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, beneath(v)]));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * `schema` with every reference at or beneath it replaced by the shape it
 * names. `enclosing` is the nodes `schema` sits in, outermost first — its
 * document's root at least; a schema holding no reference is returned as it is.
 */
export function shapeNamedBy(
  schema: Schema,
  enclosing: readonly Schema[],
  external?: ExternalSchemaResolver,
): Schema {
  return expand(
    schema,
    enclosing.filter((node) => node !== schema),
    external,
    new Set(),
  ) as Schema;
}

const CHAIN_SEGMENT = /^([a-zA-Z_][a-zA-Z0-9_]*)((?:\[\d+\])*)$/;

/**
 * The shape a plain member chain (`steps.encode.result.rows[0].id`) is declared
 * to hold in `context`, or undefined when the context does not declare it.
 *
 * `navigateSchemaToExprPath` with references read: one is followed at every hop
 * and the tail is returned as the shape it names. A union reached before the
 * chain ends is returned as that union, as there.
 */
export function navigateDeclaredChain(
  context: Schema,
  chain: string,
  external?: ExternalSchemaResolver,
): Schema | undefined {
  // The node as written and the nodes enclosing it: the tail is named from
  // there, so keywords written beside a reference stay on the shape.
  let written: Entered = { schema: context, enclosing: [context] };
  let at = enter(context, [], external);
  const step = (node: Schema) => {
    written = { schema: node, enclosing: [...at.enclosing, node] };
    at = enter(node, at.enclosing, external);
  };
  const named = () => shapeNamedBy(written.schema, written.enclosing, external);
  if (!chain) return named();
  for (const part of chain.split(".")) {
    if (at.schema.anyOf || at.schema.oneOf) return named();
    const match = part.match(CHAIN_SEGMENT);
    if (!match) return undefined;
    const [, ident, indices] = match as unknown as [string, string, string];
    const member = (at.schema.properties as Schema | undefined)?.[ident];
    if (!isSchema(member)) return undefined;
    step(member);
    for (let i = (indices.match(/\[/g) ?? []).length; i > 0; i--) {
      if (at.schema.anyOf || at.schema.oneOf) return named();
      if (!isSchema(at.schema.items)) return undefined;
      step(at.schema.items);
    }
  }
  return named();
}
