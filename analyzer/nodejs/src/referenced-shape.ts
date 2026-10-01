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
 *  - a DOCUMENT-LOCAL pointer (`#`, `#/$defs/Row`) against the root of the
 *    document that DECLARES it, which every walk here carries beside the node it
 *    is at. The root is never searched for: the caller supplies it, following a
 *    named shape makes that shape the root, and a node recorded with
 *    {@link declaredDocument} is its own. A pointer met where no root is known
 *    names nothing here — it is read as what is written beside it, so it claims
 *    nothing rather than a guess.
 *
 * A reference already being expanded is left as written, which keeps a
 * recursive shape finite and reads as a node that says nothing.
 */
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { REFERENCE_KEYS, type ExternalSchemaResolver } from "./schema-compat.js";

type Schema = Record<string, any>;

/** A schema node and the root of the document that declares it — undefined
 *  where nothing says which document that is. */
interface Declared {
  schema: Schema;
  root: Schema | undefined;
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

const declaredDocuments = new WeakSet<Schema>();

/**
 * Records `root` as the root of a declared document, and returns it.
 *
 * Called where a schema assembled from several declarations embeds one of them
 * whole — a step's `result` is its target's output contract — because only that
 * site knows the node is a document of its own: the pointers beneath it mean
 * that document, whatever it is embedded in.
 */
export function declaredDocument<T extends Schema>(root: T): T {
  declaredDocuments.add(root);
  return root;
}

/** `node` reached from a document whose root is `root`. */
const declaredAt = (node: Schema, root: Schema | undefined): Declared => ({
  schema: node,
  root: declaredDocuments.has(node) ? node : root,
});

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

/** What is written beside a reference: the node without the reference itself. */
const besideReference = (node: Schema): Schema =>
  Object.fromEntries(Object.entries(node).filter(([key]) => !REFERENCE_KEYS.has(key)));

/** What the reference at `node` names, in a document whose root is `root` — or
 *  undefined when it names nothing this can resolve. A document-local pointer
 *  with no known root names what is written beside it, and nothing more. */
function referenced(
  node: Schema,
  root: Schema | undefined,
  external: ExternalSchemaResolver | undefined,
): Declared | undefined {
  const ref = node.$ref as string;
  if (!ref.startsWith("#")) {
    const target = external?.(ref);
    return target ? { schema: target, root: target } : undefined;
  }
  if (!root) return { schema: besideReference(node), root };
  const target = resolveSchemaPointer(root, ref);
  return isSchema(target) ? { schema: target, root } : undefined;
}

/** `at` with every reference it IS followed; what it holds beneath is left. */
function enter(at: Declared, external: ExternalSchemaResolver | undefined): Declared {
  const followed = new Set<Schema>();
  while (typeof at.schema.$ref === "string" && !followed.has(at.schema)) {
    followed.add(at.schema);
    const next = referenced(at.schema, at.root, external);
    if (!next) break;
    at = next;
  }
  return at;
}

function expand(
  node: unknown,
  enclosingRoot: Schema | undefined,
  external: ExternalSchemaResolver | undefined,
  open: ReadonlySet<Schema>,
): unknown {
  if (!isSchema(node) || !holdsReference(node)) return node;
  const { root } = declaredAt(node, enclosingRoot);
  if (typeof node.$ref === "string") {
    const target = referenced(node, root, external);
    if (!target || open.has(target.schema)) return node;
    const named = expand(
      target.schema,
      target.root,
      external,
      new Set(open).add(target.schema),
    ) as Schema;
    // The reference's own keys go; a `title` or `description` beside it stays.
    const siblings = Object.entries(node).filter(([key]) => !REFERENCE_KEYS.has(key));
    return siblings.length === 0 ? named : { ...named, ...Object.fromEntries(siblings) };
  }
  const beneath = (value: unknown) => expand(value, root, external, open);
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
 * names. `root` is the root of the document that declares `schema` — `schema`
 * itself for a whole document, undefined where that is not known; a schema
 * holding no reference is returned as it is.
 */
export function shapeNamedBy(
  schema: Schema,
  root: Schema | undefined,
  external?: ExternalSchemaResolver,
): Schema {
  return expand(schema, root, external, new Set()) as Schema;
}

const CHAIN_SEGMENT = /^([a-zA-Z_][a-zA-Z0-9_]*)((?:\[\d+\])*)$/;

/**
 * The shape a plain member chain (`steps.encode.result.rows[0].id`) is declared
 * to hold in `context`, or undefined when the context does not declare it.
 *
 * `navigateSchemaToExprPath` with references read: one is followed at every hop
 * and the tail is returned as the shape it names. A union reached before the
 * chain ends is returned as that union, as there.
 *
 * `context` is assembled from several declarations, so it is no document's
 * root: the chain enters one where it reaches a node recorded with
 * {@link declaredDocument}, or follows a named shape.
 */
export function navigateDeclaredChain(
  context: Schema,
  chain: string,
  external?: ExternalSchemaResolver,
): Schema | undefined {
  // The node as written: the tail is named from there, so keywords written
  // beside a reference stay on the shape.
  let written = declaredAt(context, undefined);
  let at = enter(written, external);
  const step = (node: Schema) => {
    written = declaredAt(node, at.root);
    at = enter(written, external);
  };
  const named = () => shapeNamedBy(written.schema, written.root, external);
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
