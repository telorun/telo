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
import { valueTypeOf } from "@telorun/sdk";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { deepEquals } from "./migrations/match.js";
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

/** `at` with every reference it IS followed, and whether each one could be:
 *  one that names nothing, one whose document is not known, or one already
 *  open leaves `followed` false. */
function enter(
  at: Declared,
  external: ExternalSchemaResolver | undefined,
): { at: Declared; followed: boolean } {
  const seen = new Set<Schema>();
  while (typeof at.schema.$ref === "string") {
    if (seen.has(at.schema)) return { at, followed: false };
    seen.add(at.schema);
    const next = referenced(at.schema, at.root, external);
    if (!next) return { at, followed: false };
    if (at.schema.$ref.startsWith("#") && !at.root) return { at: next, followed: false };
    at = next;
  }
  return { at, followed: true };
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

/** One hop of a chain: a member by name, or — undefined — an index. */
type Hop = string | undefined;

/** What `node` itself declares for `hop`. */
const declaredFor = (node: Schema, hop: Hop): unknown =>
  hop === undefined ? node.items : (node.properties as Schema | undefined)?.[hop];

/** True when no value `node` admits has `hop`, so the access fails there at run:
 *  its declared type leaves out the container the hop reads, or it is a closed
 *  object that does not declare the member. */
function cannotHold(node: Schema, hop: Hop): boolean {
  const holds = (value: unknown) => (hop === undefined ? Array.isArray(value) : isSchema(value));
  const entry = valueTypeOf(node);
  if (entry?.representation === "instance") return true;
  const container = hop === undefined ? "array" : "object";
  const type: unknown = node.type ?? entry?.base;
  if (typeof type === "string" ? type !== container : Array.isArray(type) && !type.includes(container)) {
    return true;
  }
  if ("const" in node && !holds(node.const)) return true;
  if (Array.isArray(node.enum) && !node.enum.some(holds)) return true;
  return (
    hop !== undefined &&
    node.additionalProperties === false &&
    node.patternProperties === undefined &&
    !(isSchema(node.properties) && Object.hasOwn(node.properties, hop))
  );
}

/** Nodes held by node and root, each once. */
class DeclaredSet {
  private readonly roots = new Map<Schema, Set<Schema | undefined>>();
  readonly members: Declared[] = [];

  has(at: Declared): boolean {
    return this.roots.get(at.schema)?.has(at.root) ?? false;
  }

  add(at: Declared): void {
    if (this.has(at)) return;
    let roots = this.roots.get(at.schema);
    if (!roots) this.roots.set(at.schema, (roots = new Set()));
    roots.add(at.root);
    this.members.push(at);
  }
}

const ANNOTATION_KEYS: ReadonlySet<string> = new Set(["title", "description", "$comment"]);

/** The alternatives of a node that is a union and constrains nothing else. */
function bareUnion(shape: Schema): Schema[] | undefined {
  const keys = Object.keys(shape).filter((key) => !ANNOTATION_KEYS.has(key));
  if (keys.length !== 1 || (keys[0] !== "anyOf" && keys[0] !== "oneOf")) return undefined;
  const alternatives: unknown = shape[keys[0]];
  return Array.isArray(alternatives) && alternatives.length > 0 && alternatives.every(isSchema)
    ? alternatives
    : undefined;
}

/**
 * The shape a plain member chain (`steps.encode.result.rows[0].id`) is declared
 * to hold in `context`, or undefined when the context does not declare it.
 *
 * A reference is followed at every hop and the tail is returned as the shape it
 * names. A chain that ends on a union holds that union.
 *
 * **A chain that continues past a union (`anyOf` / `oneOf`) is read in every
 * alternative.** A union's own `properties` (`items`, for an index) are read
 * first; where they do not declare the hop, each alternative is one of:
 *
 *  - it declares the hop — the chain continues inside it;
 *  - no value of it has the hop — its declared type leaves out an object (an
 *    array, for an index), or it is a closed object that omits the member — so
 *    the access fails there at run and it contributes nothing;
 *  - it could hold the hop and says nothing of it (an open object without the
 *    member, an untyped node, a reference that cannot be followed, a union
 *    already open) — the whole chain claims nothing;
 *  - itself a union — distributed the same way.
 *
 * What the chain holds is then the flat `anyOf` of what the remaining
 * alternatives declare at its tail, a bare union there contributing its own
 * alternatives, structurally equal ones collapsed — and that one shape itself
 * where they all agree. Nothing is claimed when no alternative remains. A
 * `null` alternative crossed on the way is dropped, so it does not make the
 * tail nullable.
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
  // Nodes as written: the tail is named from there, so keywords written beside
  // a reference stay on the shape.
  let held: Declared[] = [declaredAt(context, undefined)];
  let crossedUnion = false as boolean;

  /** Every held node moved one hop on; false when the chain claims nothing. */
  const advance = (hop: Hop): boolean => {
    const next = new DeclaredSet();
    const open = new Set<Schema>();
    const distributed = new DeclaredSet();
    const reach = (written: Declared, alternative: boolean): boolean => {
      const { at, followed } = enter(written, external);
      const own = declaredFor(at.schema, hop);
      // An alternative behind a reference that cannot be followed says nothing,
      // whatever is written beside it.
      if (!followed && (alternative || !isSchema(own))) return false;
      if (isSchema(own)) {
        next.add(declaredAt(own, at.root));
        return true;
      }
      if (cannotHold(at.schema, hop)) return true;
      const alternatives: unknown = at.schema.anyOf ?? at.schema.oneOf;
      if (!Array.isArray(alternatives) || alternatives.length === 0) return false;
      if (open.has(at.schema)) return false;
      if (distributed.has(at)) return true;
      crossedUnion = true;
      open.add(at.schema);
      const claimed = alternatives.every(
        // `false` admits no value; any other non-schema says nothing.
        (branch) =>
          isSchema(branch) ? reach(declaredAt(branch, at.root), true) : branch === false,
      );
      open.delete(at.schema);
      distributed.add(at);
      return claimed;
    };
    if (!held.every((written) => reach(written, false))) return false;
    held = next.members;
    return held.length > 0;
  };

  if (chain) {
    for (const part of chain.split(".")) {
      const match = part.match(CHAIN_SEGMENT);
      if (!match) return undefined;
      const [, ident, indices] = match as unknown as [string, string, string];
      if (!advance(ident)) return undefined;
      for (let i = (indices.match(/\[/g) ?? []).length; i > 0; i--) {
        if (!advance(undefined)) return undefined;
      }
    }
  }

  const named = held.map((written) => shapeNamedBy(written.schema, written.root, external));
  if (!crossedUnion) return named[0];
  const tails: Schema[] = [];
  const contribute = (shape: Schema): void => {
    const alternatives = bareUnion(shape);
    if (alternatives) alternatives.forEach(contribute);
    else if (!tails.some((tail) => deepEquals(tail, shape))) tails.push(shape);
  };
  named.forEach(contribute);
  return tails.length === 1 ? tails[0] : { anyOf: tails };
}
