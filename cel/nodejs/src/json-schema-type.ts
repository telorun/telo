/**
 * JSON Schema as a CEL type — the checker's native input, to full depth.
 *
 * A host knows the shape of what it binds as a schema, not as a CEL type, and the
 * conversion is where a checker either keeps that knowledge or throws it away. This
 * one keeps it: nested objects become records of records, `items` becomes the element
 * type, `additionalProperties` becomes the value type of a map, a union stays a
 * **union** instead of collapsing to `dyn`, and a reference is followed. A typo two
 * levels into a schema-typed variable is then a type error with a range, where an
 * engine typing an object as a flat field map can only shrug at anything below the
 * first level.
 *
 * **Nothing a schema says may fall through to `dyn` in silence.** That is the rule the
 * rest of this file implements, and it is a stronger statement than "every keyword is
 * read": a keyword this reader has no rule for is **reported**, by JSON Pointer, beside
 * the type produced in its place. Completeness rests on
 * `TYPE_CONSTRAINING_KEYWORDS` — an engine-owned, closed list of the keywords that can
 * change what CEL type a node has. A node carrying one this reader does not read is
 * reported; a node carrying none of them says nothing about its type and is `dyn`
 * legitimately, unreported.
 *
 * **It reports rather than refuses.** A node this reader cannot type is usually a third
 * party's data — a schema shipped inside something a host merely loaded. Throwing at
 * registration would turn someone else's schema into a crash; typing it `dyn` quietly is
 * the hole itself. A report lets the one consumer that knows where the schema was
 * written anchor a diagnostic at that line.
 *
 * **References split at the document boundary, and the split is the point.**
 *
 * - A **document-local** reference (`#/$defs/…`, `#/definitions/…`) is resolved here,
 *   against the document in hand. The engine's input is therefore a node **plus the
 *   document it belongs to**, the document travelling with the node as the descent moves
 *   between documents.
 * - A reference that **leaves** the document is answered by the host's own resolver —
 *   the one this file already consults at every node — whose answer is a registered type
 *   name with arguments, **or the document to read in place of this node**. Which
 *   document a reference outside this one resolves against, and how a relative reference
 *   is rebased, is the host's half; there is no copy of it here and no second seam.
 *
 * A reference **re-entered** on the descent — a recursive schema — is the one deliberate
 * `dyn`, and it is declared as such (`recursive`) rather than reported: the outer reading
 * is what the consumer gets and the descent terminates.
 *
 * **Conversion is memoized by node identity within a document**, because the same schema
 * object is handed over on every keystroke in an editor and a deep schema is not cheap to
 * walk twice. A document a reference resolves to is memoized the same way, so a shape
 * referenced a hundred times converts once and the cost stays linear in the nodes
 * actually reached — so a node reached twice is also reported once, at the pointer it was
 * first reached by. The host's resolver stays a function rather than a handed-over map of
 * every shape it knows, which is what keeps one registration from costing the size of a
 * host's whole workspace.
 */

import type { CelType, RecordType, UnionType } from "./cel-type.js";
import {
  assignable,
  BOOL,
  DOUBLE,
  DYN,
  INT,
  isDyn,
  listOf,
  mapOf,
  NULL,
  STRING,
  typesEqual,
  unionOf,
} from "./cel-type.js";

/** The keywords this reads. Anything else in a schema is, here, absent. */
export interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly additionalProperties?: boolean | JsonSchemaNode;
  readonly items?: JsonSchemaNode | readonly JsonSchemaNode[];
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly allOf?: readonly JsonSchemaNode[];
  readonly $ref?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly required?: readonly string[];
  readonly [keyword: string]: unknown;
}

/**
 * A node and the document it belongs to.
 *
 * A `#/…` reference inside `node` resolves against `root`; where the node **is** the
 * document — a host registering a whole schema, which is the common case — `root` is
 * absent and the node stands as its own document.
 */
export interface JsonSchemaDocument {
  readonly node: JsonSchemaNode;
  readonly root?: JsonSchemaNode;
}

/**
 * What the host says a schema node is, before its structure is read: a registered type
 * name with its type arguments, the document to read in place of this node, or nothing.
 *
 * The second form is how a reference leaving the document is answered. The host is given
 * the node **and the document it belongs to**, because that is what identifies a
 * reference's base — and rebasing is the host's rule, not this engine's.
 */
export type SchemaTypeAnswer =
  | { readonly name: string; readonly args?: readonly string[] }
  | { readonly document: JsonSchemaDocument };

export type SchemaTypeResolver = (document: JsonSchemaDocument) => SchemaTypeAnswer | undefined;

/** How a named type a resolver answers becomes a type. */
export type NamedTypeLookup = (name: string, args: readonly string[]) => CelType | undefined;

export interface SchemaConversion {
  readonly resolveSchemaType?: SchemaTypeResolver;
  readonly lookupNamedType?: NamedTypeLookup;
}

/**
 * Why a node could not be judged. Closed, and each member is a fact about the schema:
 *
 * - `keyword-not-read` — the node carries a type-constraining keyword this reader has no
 *   rule for.
 * - `shape-not-read` — a keyword this reader does read, in a form it does not: a tuple
 *   `items`, a `type` naming no JSON type.
 * - `reference-unresolved` — a reference that leaves the document and that the host's
 *   resolver did not answer, or a document-local pointer naming nothing.
 * - `intersection-empty` — two things the node says about its own type cannot both hold.
 * - `named-type-unregistered` — the host's resolver named a type and nothing is registered
 *   under that name: the host disagreeing with itself, which must not be silent either.
 */
export const UNJUDGED_REASONS = [
  "keyword-not-read",
  "shape-not-read",
  "reference-unresolved",
  "intersection-empty",
  "named-type-unregistered",
] as const;

export type UnjudgedReason = (typeof UNJUDGED_REASONS)[number];

export interface UnjudgedSchemaNode {
  /** JSON Pointer to the node, within the document it was found in. */
  readonly pointer: string;
  /**
   * The JSON Pointer, in the document the conversion was given, of the reference that
   * first led out of it. Absent when the node is in that document, so a consumer anchors
   * a diagnostic at `throughReference ?? pointer`.
   */
  readonly throughReference?: string;
  /** The keywords at that node this reader could not read; none, where no keyword is the cause. */
  readonly keywords: readonly string[];
  /** The type name the host's resolver answered, where that is the cause. */
  readonly typeName?: string;
  readonly reason: UnjudgedReason;
}

/** A reference re-entered on the descent: a recursive schema, deliberately `dyn`. */
export interface RecursiveSchemaReference {
  /** JSON Pointer to the node re-entered, within the document it was found in. */
  readonly pointer: string;
  readonly throughReference?: string;
  /** The reference that led back, where a reference did. */
  readonly reference?: string;
}

export interface SchemaTypeResult {
  readonly type: CelType;
  /** Every node this reader could not judge. Empty is the whole schema judged. */
  readonly unjudged: readonly UnjudgedSchemaNode[];
  readonly recursive: readonly RecursiveSchemaReference[];
}

/**
 * Every keyword that can change what CEL type a node has — the closed list completeness
 * is measured against.
 *
 * A keyword that constrains a **value** rather than its type is deliberately absent:
 * `required` (presence), `contains` (that some element matches, which fixes no element
 * type), `propertyNames` (a JSON object's keys are strings whatever it says), `format`,
 * `pattern` and every numeric, string and array bound. None of them can move a type, so
 * reporting them would be noise a consumer learns to ignore.
 *
 * **The blind spot, written down:** this list is the engine's own, so a keyword that
 * constrains a type and is on no list at all is invisible — it falls through as "a node
 * carrying nothing", which `tests/schema-keyword-coverage.test.ts` pins as `dyn` and
 * unreported. Nothing here can cover that class, because nothing under this package knows
 * JSON Schema's vocabulary; what covers it is that the list and the reader are held to
 * each other in both directions, so adding the keyword is a one-line change that cannot
 * be half done.
 */
export const TYPE_CONSTRAINING_KEYWORDS: readonly string[] = [
  "$dynamicRef",
  "$recursiveRef",
  "$ref",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "dependentSchemas",
  "else",
  "enum",
  "if",
  "items",
  "not",
  "oneOf",
  "patternProperties",
  "prefixItems",
  "properties",
  "then",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
];

/** The keywords of that list this reader reads. Every other one on it is reported. */
export const TYPE_KEYWORDS_READ: readonly string[] = [
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "enum",
  "items",
  "oneOf",
  "properties",
  "type",
];

const KEYWORDS_NOT_READ = TYPE_CONSTRAINING_KEYWORDS.filter(
  (keyword) => !TYPE_KEYWORDS_READ.includes(keyword),
);

const SCALARS: Readonly<Record<string, CelType>> = {
  string: STRING,
  integer: INT,
  number: DOUBLE,
  boolean: BOOL,
  null: NULL,
};

/** The type a schema declares, read to full depth, beside what it could not judge. */
export function schemaType(
  document: JsonSchemaDocument,
  conversion: SchemaConversion = {},
): SchemaTypeResult {
  const reader = new SchemaReader(conversion);
  const type = reader.read(document.node, document.root ?? document.node, "", undefined, undefined);
  return { type, unjudged: reader.unjudged, recursive: reader.recursive };
}

/** One part of what a node says about its own type, and the keyword that said it. */
interface TypePart {
  readonly keyword: string;
  readonly type: CelType;
}

/** What has been read of one document: its memo, and what is being read right now. */
interface DocumentState {
  readonly done: Map<JsonSchemaNode, CelType>;
  readonly active: Set<JsonSchemaNode>;
}

class SchemaReader {
  readonly unjudged: UnjudgedSchemaNode[] = [];
  readonly recursive: RecursiveSchemaReference[] = [];
  /** Keyed by document, so one node read under two documents is read against each. */
  private readonly documents = new Map<JsonSchemaNode, DocumentState>();

  constructor(private readonly conversion: SchemaConversion) {}

  read(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
    arrivedBy: string | undefined,
  ): CelType {
    // Not an object: nothing a node said, so nothing to judge.
    if (typeof node !== "object" || node === null) return DYN;
    const state = this.documentState(root);
    const held = state.done.get(node);
    if (held) return held;
    if (state.active.has(node)) {
      this.recursive.push({
        pointer,
        ...(through === undefined ? {} : { throughReference: through }),
        ...(arrivedBy === undefined ? {} : { reference: arrivedBy }),
      });
      return DYN;
    }
    state.active.add(node);
    let type: CelType;
    try {
      type = this.readNode(node, root, pointer, through);
    } finally {
      state.active.delete(node);
    }
    state.done.set(node, type);
    return type;
  }

  private documentState(root: JsonSchemaNode): DocumentState {
    const held = this.documents.get(root);
    if (held) return held;
    const state: DocumentState = { done: new Map(), active: new Set() };
    this.documents.set(root, state);
    return state;
  }

  private readNode(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    const answer = this.conversion.resolveSchemaType?.({ node, root });
    if (answer && "document" in answer) {
      // The host answered a document: the descent crosses into it, and a pointer from
      // here on is within that document. The reference that first left the conversion's
      // own document is what a consumer anchors at, so the first crossing is the one kept.
      const crossed = answer.document;
      return this.read(crossed.node, crossed.root ?? crossed.node, "", through ?? pointer, undefined);
    }
    if (answer) {
      const type = this.conversion.lookupNamedType?.(answer.name, answer.args ?? []);
      if (type) return type;
      // The host named a type nothing is registered under — its own disagreement with itself.
      // Falling through to the structural rules is the right READING, but doing it quietly
      // is the same silence this report exists to end, so it is reported beside that reading.
      this.report(pointer, through, [], "named-type-unregistered", answer.name);
    }
    this.reportUnreadKeywords(node, pointer, through);
    return this.meet(this.parts(node, root, pointer, through), pointer, through);
  }

  /** Everything the node says about its own type, each with the keyword that said it. */
  private parts(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): readonly TypePart[] {
    const parts: TypePart[] = [];
    if (typeof node.$ref === "string") {
      parts.push({ keyword: "$ref", type: this.reference(node.$ref, root, pointer, through) });
    }
    if (node.allOf && node.allOf.length > 0) {
      const branches = node.allOf.map((branch, at) => ({
        keyword: "allOf",
        type: this.read(branch, root, `${pointer}/allOf/${at}`, through, undefined),
      }));
      parts.push({ keyword: "allOf", type: this.meet(branches, pointer, through) });
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!branches || branches.length === 0) continue;
      parts.push({
        keyword,
        type: unionOf(
          branches.map((branch, at) => this.read(branch, root, `${pointer}/${keyword}/${at}`, through, undefined)),
        ),
      });
    }
    const structural = this.structure(node, root, pointer, through);
    if (structural) parts.push(structural);
    return parts;
  }

  /** What `type`, `properties`, `items` or a constant value say, in that order. */
  private structure(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): TypePart | undefined {
    if (Array.isArray(node.type)) {
      return {
        keyword: "type",
        type: unionOf(node.type.map((name) => this.ofType(name, node, root, pointer, through))),
      };
    }
    if (typeof node.type === "string") {
      return { keyword: "type", type: this.ofType(node.type, node, root, pointer, through) };
    }
    if (node.properties || node.additionalProperties !== undefined) {
      return { keyword: "properties", type: this.record(node, root, pointer, through) };
    }
    if (node.items !== undefined) {
      return { keyword: "items", type: this.array(node, root, pointer, through) };
    }
    // A constant or an enumeration with no `type` still says what JSON type its values
    // hold, which is the difference between `string` and an unjudged node.
    if ("const" in node) return { keyword: "const", type: jsonValueType(node.const) };
    if (node.enum && node.enum.length > 0) {
      return { keyword: "enum", type: unionOf(node.enum.map(jsonValueType)) };
    }
    return undefined;
  }

  private ofType(
    name: string,
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    const scalar = SCALARS[name];
    if (scalar) return scalar;
    if (name === "object") return this.record(node, root, pointer, through);
    if (name === "array") return this.array(node, root, pointer, through);
    this.report(pointer, through, ["type"], "shape-not-read");
    return DYN;
  }

  private record(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    const properties = node.properties;
    const additional = node.additionalProperties;
    const additionalType =
      additional === undefined || typeof additional === "boolean"
        ? undefined
        : this.read(additional, root, `${pointer}/additionalProperties`, through, undefined);
    if (!properties) {
      // No declared property: a schema that says what any value is, is a map of it; one
      // that admits anything is a map of anything; one that admits nothing holds no field.
      if (additionalType) return mapOf(STRING, additionalType);
      if (additional === false) return { kind: "record", fields: new Map(), open: false };
      return mapOf(STRING, DYN);
    }
    const fields = new Map<string, CelType>();
    for (const [name, property] of Object.entries(properties)) {
      fields.set(name, this.read(property, root, `${pointer}/properties/${escapeSegment(name)}`, through, undefined));
    }
    return { kind: "record", fields, open: additional === true };
  }

  private array(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    const items = node.items;
    if (Array.isArray(items)) {
      // A tuple: each position has its own type, which a CEL list type cannot hold.
      this.report(pointer, through, ["items"], "shape-not-read");
      return listOf(DYN);
    }
    if (!items) return listOf(DYN);
    return listOf(this.read(items as JsonSchemaNode, root, `${pointer}/items`, through, undefined));
  }

  /** A document-local reference, resolved here; anything else was the host's to answer. */
  private reference(
    reference: string,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    if (!reference.startsWith("#")) {
      // The host's resolver was asked at this node and did not answer it.
      this.report(pointer, through, ["$ref"], "reference-unresolved");
      return DYN;
    }
    const target = nodeAtPointer(root, reference.slice(1));
    if (!target) {
      this.report(pointer, through, ["$ref"], "reference-unresolved");
      return DYN;
    }
    return this.read(target, root, reference.slice(1), through, reference);
  }

  /**
   * The one type every part admits: records merge field-wise, a narrower scalar wins, and
   * two parts that cannot both hold are reported rather than quietly resolved one way.
   */
  private meet(
    parts: readonly TypePart[],
    pointer: string,
    through: string | undefined,
  ): CelType {
    if (parts.length === 0) return DYN;
    let met = parts[0]!;
    for (const part of parts.slice(1)) {
      const both = intersectTypes(met.type, part.type);
      if (!both) {
        this.report(pointer, through, [met.keyword, part.keyword], "intersection-empty");
        return DYN;
      }
      met = { keyword: part.keyword, type: both };
    }
    return met.type;
  }

  private reportUnreadKeywords(
    node: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): void {
    const present = KEYWORDS_NOT_READ.filter((keyword) => keyword in node);
    if (present.length > 0) this.report(pointer, through, present, "keyword-not-read");
  }

  private report(
    pointer: string,
    through: string | undefined,
    keywords: readonly string[],
    reason: UnjudgedReason,
    typeName?: string,
  ): void {
    this.unjudged.push({
      pointer,
      ...(through === undefined ? {} : { throughReference: through }),
      keywords: [...new Set(keywords)],
      ...(typeName === undefined ? {} : { typeName }),
      reason,
    });
  }
}

/** The JSON type a constant or an enumerated value holds. */
function jsonValueType(value: unknown): CelType {
  if (value === null) return NULL;
  switch (typeof value) {
    case "boolean":
      return BOOL;
    case "string":
      return STRING;
    case "number":
      return Number.isInteger(value) ? INT : DOUBLE;
    case "object":
      return Array.isArray(value) ? listOf(DYN) : mapOf(STRING, DYN);
    default:
      return DYN;
  }
}

/**
 * The one type both admit, or nothing when they cannot both hold.
 *
 * `undefined` is "no value satisfies both" — an unsatisfiable schema, which the caller
 * reports rather than resolving in one direction and hiding the contradiction.
 */
function intersectTypes(left: CelType, right: CelType): CelType | undefined {
  if (isDyn(left)) return right;
  if (isDyn(right)) return left;
  if (typesEqual(left, right)) return left;
  if (left.kind === "union" || right.kind === "union") {
    const union = (left.kind === "union" ? left : right) as UnionType;
    const other = left.kind === "union" ? right : left;
    const met = union.members
      .map((member) => intersectTypes(member, other))
      .filter((member): member is CelType => member !== undefined);
    return met.length === 0 ? undefined : unionOf(met);
  }
  if (left.kind === "record" && right.kind === "record") return intersectRecords(left, right);
  if (left.kind === "record" && right.kind === "map") return intersectRecordWithMap(left, right.value);
  if (right.kind === "record" && left.kind === "map") return intersectRecordWithMap(right, left.value);
  if (left.kind === "map" && right.kind === "map") {
    const key = intersectTypes(left.key, right.key);
    const value = intersectTypes(left.value, right.value);
    return key && value ? mapOf(key, value) : undefined;
  }
  if (left.kind === "list" && right.kind === "list") {
    const element = intersectTypes(left.element, right.element);
    return element ? listOf(element) : undefined;
  }
  if (left.kind === "optional" && right.kind === "optional") {
    const value = intersectTypes(left.value, right.value);
    return value ? { kind: "optional", value } : undefined;
  }
  // Whichever stands where the other is wanted is the narrower of the two.
  if (assignable(left, right)) return left;
  if (assignable(right, left)) return right;
  return undefined;
}

/**
 * Two records meet as the union of their fields — which is what composing a shape out of
 * two partial ones means, and what makes a field of each readable and a third an error.
 * Closed beats open: a reader of the composition may rely on either half's refusal.
 */
function intersectRecords(left: RecordType, right: RecordType): CelType | undefined {
  const fields = new Map(left.fields);
  for (const [name, type] of right.fields) {
    const held = fields.get(name);
    if (held === undefined) {
      fields.set(name, type);
      continue;
    }
    const both = intersectTypes(held, type);
    if (!both) return undefined;
    fields.set(name, both);
  }
  return {
    kind: "record",
    fields,
    open: left.open && right.open,
    ...(left.name === undefined ? {} : { name: left.name }),
  };
}

/** A record against a map's value type: every field must also be a value of the map. */
function intersectRecordWithMap(record: RecordType, value: CelType): CelType | undefined {
  const fields = new Map<string, CelType>();
  for (const [name, type] of record.fields) {
    const both = intersectTypes(type, value);
    if (!both) return undefined;
    fields.set(name, both);
  }
  return { ...record, fields };
}

/** A JSON Pointer segment, escaped as RFC 6901 writes it. */
function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The node a JSON Pointer names within a document, or nothing where it names none. */
function nodeAtPointer(root: JsonSchemaNode, pointer: string): JsonSchemaNode | undefined {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let at: unknown = root;
  for (const segment of pointer.slice(1).split("/")) {
    const name = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof at !== "object" || at === null) return undefined;
    at = Array.isArray(at) ? at[Number(name)] : (at as Record<string, unknown>)[name];
    if (at === undefined) return undefined;
  }
  return typeof at === "object" && at !== null ? (at as JsonSchemaNode) : undefined;
}

/** A field map, each field a type expression or a nested field map. */
export type FieldDeclaration = string | { readonly fields: Readonly<Record<string, FieldDeclaration>> };

/**
 * An object type written as a field map rather than as a schema.
 *
 * It is how a host states a shape it holds no schema for — and how a shallow typing,
 * where every field is `map` or `list`, is still expressible: a consumer that must
 * reproduce an older engine's verdicts exactly needs to be able to say "this much and
 * no more", and a converter that only ever goes deep would force every such consumer
 * to become stricter on the same day it changes engines.
 */
export function fieldMapType(
  fields: Readonly<Record<string, FieldDeclaration>>,
  readType: (text: string) => CelType,
): CelType {
  const read = new Map<string, CelType>();
  for (const [name, declaration] of Object.entries(fields)) {
    read.set(
      name,
      typeof declaration === "string" ? readType(declaration) : fieldMapType(declaration.fields, readType),
    );
  }
  return { kind: "record", fields: read, open: false };
}
