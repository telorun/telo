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

import type { CelType, FieldEnumValue, ListType, PatternField, PatternPart, RecordType, UnionType } from "./cel-type.js";
import type { EdgeKey, SchemaDependency, SchemaProvenance, SchemaReads, WholeRead } from "./schema-dependencies.js";
import {
  ADDITIONAL_EDGE,
  ELEMENT_EDGE,
  joinedReads,
  keptIn,
  NO_SCHEMA_READS,
  partAdditionalEdge,
  patternEdge,
} from "./schema-dependencies.js";
import { patternStanding } from "./record-member.js";
import { re2Pattern } from "./regular-expression.js";
import {
  assignable,
  BOOL,
  compareFieldEnumValues,
  DOUBLE,
  DYN,
  INT,
  isDyn,
  listOf,
  mapOf,
  NULL,
  partMatches,
  recordOf,
  STRING,
  tupleOf,
  typesEqual,
  unify,
  unionOf,
} from "./cel-type.js";
import { UNION_EXPANSION_LIMIT } from "./function-registry.js";
import { countTypeVisit } from "./type-visits.js";

/** The keywords this reads. Anything else in a schema is, here, absent. */
export interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly patternProperties?: Readonly<Record<string, boolean | JsonSchemaNode>>;
  readonly additionalProperties?: boolean | JsonSchemaNode;
  readonly items?: boolean | JsonSchemaNode | readonly (boolean | JsonSchemaNode)[];
  readonly prefixItems?: readonly (boolean | JsonSchemaNode)[];
  readonly additionalItems?: boolean | JsonSchemaNode;
  readonly not?: boolean | JsonSchemaNode;
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

/**
 * How a named type a resolver answers becomes a type: read as the type-expression grammar
 * reads a name, CEL's own types first, then the registered ones. Nothing where it is
 * neither.
 */
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
 * - `shape-not-read` — a keyword this reader does read, in a form it does not: `prefixItems`
 *   beside `additionalItems` or an array `items`, a `type` naming no JSON type, a `not`
 *   whose subschema says more about a type than `type`, `const` and `enum` do, a
 *   `patternProperties` pattern RE2 refuses, and a meet whose unions would build more than
 *   `UNION_EXPANSION_LIMIT` members.
 * - `reference-unresolved` — a reference that leaves the document and that the host's
 *   resolver did not answer, or a document-local pointer naming nothing.
 * - `intersection-empty` — the schema admits no value where absence cannot be stated: at a
 *   registration's root, where two things it says about its own type cannot both hold or it
 *   admits no value. Beneath a container the same node is read as absence.
 * - `named-type-unregistered` — the host's resolver named a type that is neither one of
 *   CEL's own nor registered under that name: the host disagreeing with itself, which must
 *   not be silent either.
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
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
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
];

/** The type keywords a `not` subschema may carry and still be read: it excludes whole types. */
export const NEGATION_TYPE_KEYWORDS: readonly string[] = ["const", "enum", "type"];

/** Keywords that say nothing about a value: a subschema holding only these admits every value. */
export const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

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
  return readSchemaType(document, conversion).result;
}

/** A conversion's reading, beside where each type it built came from and what building them cost. */
export interface SchemaTypeReading {
  readonly result: SchemaTypeResult;
  readonly provenance: SchemaProvenance;
  /** How many holders the containers its intersections built keep. */
  readonly heldHolders: number;
  /** How many containers its intersections built, each counted once however many meets answered it. */
  readonly builtContainers: number;
  /** How many entries — nodes, whole types, parts — the readings it built hold. */
  readonly readsEntries: number;
}

/** The same reading, beside where each type it built came from (`schema-dependencies.ts`) and what it cost. */
export function readSchemaType(document: JsonSchemaDocument, conversion: SchemaConversion = {}): SchemaTypeReading {
  const reader = new SchemaReader(conversion);
  const root = document.root ?? document.node;
  const read = reader.read(document.node, root, document.node, "", undefined, undefined);
  // Absence has nowhere to be stated at the root, so a schema admitting no value there is
  // two things it says that cannot both hold.
  if (read.none) reader.reportNoValue("", read.none);
  return {
    result: { type: read.type, unjudged: reader.unjudged, recursive: reader.recursive },
    provenance: {
      root: read.reads,
      rootNode: read.node,
      edges: reader.edges,
      memberNodes: reader.memberNodes,
      unionNodes: reader.unionNodes,
    },
    heldHolders: reader.heldHolders,
    builtContainers: reader.builtContainers,
    readsEntries: reader.readsEntries,
  };
}

/**
 * A schema that admits no value — `false`, `not: {}`, a conditional neither branch of which
 * can hold — and the keywords that say so. Its holder states it as absence where it can (a
 * member, the members it does not declare, a tuple's rest, a union branch) and reports it
 * where it cannot.
 */
interface NoValue {
  readonly keywords: readonly string[];
}

/** A type, what reading it reads, and the node it was read from. */
interface Read {
  readonly type: CelType;
  readonly reads: SchemaReads;
  readonly node: SchemaDependency;
  readonly none?: NoValue;
  /** The finite set of values the node admits, as written; absent where it is not finite. */
  readonly values?: readonly JsonScalar[];
}

/** A value a finite set is written with. */
type JsonScalar = string | number | boolean | null;

/**
 * What a node says about its own type before it is read as that node: `node` where the type
 * was read from another node — a reference's target, a crossed document, the one branch a
 * union kept — and absent where this node built it.
 */
interface OwnRead {
  readonly type: CelType;
  readonly reads: SchemaReads;
  readonly node?: SchemaDependency;
  readonly none?: NoValue;
  readonly values?: readonly JsonScalar[];
}

/** A container member's reads and, where it was read straight from one, its node. */
interface MemberRead {
  readonly reads: SchemaReads;
  readonly node?: SchemaDependency;
}

/** One part of what a node says about its own type, and the keyword that said it. */
interface TypePart extends OwnRead {
  readonly keyword: string;
}

/**
 * One part holding a member position of a container an intersection met: the node it read the
 * member from, where it did, what reading that member reads, and whether it types the member
 * as something other than `dyn`.
 */
interface Holder {
  readonly node: SchemaDependency | undefined;
  readonly reads: SchemaReads;
  readonly typed: boolean;
}

/** Per member of a container an intersection built, the parts holding it, in written order. */
interface Declaring {
  readonly members: ReadonlyMap<EdgeKey, readonly Holder[]>;
  /** Per member declared absent, the parts declaring it so. */
  readonly absent: ReadonlyMap<string, readonly Holder[]>;
}

const NO_HOLDERS: readonly Holder[] = [];

/**
 * The holders as each distinct one in the order it first occurs, held once or — where it
 * occurs again — twice. Twice already says several parts hold a member, which is all a count
 * is read for; a type an intersection built, met with itself, would otherwise double its list
 * at every level it is met again. Canonical, so a list met again is the list it was, and
 * concatenating canonical lists answers what concatenating the lists they came from would.
 */
function canonicalHolders(holders: readonly Holder[]): readonly Holder[] {
  if (holders.length < 2) return holders;
  const counts = new Map<Holder, number>();
  for (const holder of holders) counts.set(holder, Math.min(2, (counts.get(holder) ?? 0) + 1));
  if (counts.size === holders.length) return holders;
  const canonical: Holder[] = [];
  for (const [holder, count] of counts) {
    canonical.push(holder);
    if (count === 2) canonical.push(holder);
  }
  return canonical;
}

/** What has been read of one document: its memo, and what is being read right now. */
interface DocumentState {
  readonly done: Map<JsonSchemaNode, Read>;
  readonly active: Set<JsonSchemaNode>;
}

class SchemaReader {
  readonly unjudged: UnjudgedSchemaNode[] = [];
  readonly recursive: RecursiveSchemaReference[] = [];
  readonly edges = new Map<CelType, Map<EdgeKey, SchemaReads>>();
  readonly memberNodes = new Map<CelType, Map<EdgeKey, SchemaDependency>>();
  readonly unionNodes = new Map<CelType, readonly SchemaDependency[]>();
  private readonly declaring = new Map<CelType, Declaring>();
  /** How many holders the containers an intersection built keep, which is what placing them costs. */
  heldHolders = 0;
  builtContainers = 0;
  readsEntries = 0;
  /** Every meet this conversion answered (the computed table). */
  private readonly answers = new MeetAnswers();
  /** Each container an intersection built, by everything its readers observe of it (the unique table). */
  private readonly containers = new Map<string, CelType>();
  /** Each holder, by the side, member and typing it stands for, so a holder's identity is its content. */
  private readonly holderTable = new Map<CelType, Map<EdgeKey, [Holder?, Holder?]>>();
  /** A number per type, holder and edge a unique-table key names. */
  private readonly identities = new Map<unknown, number>();
  /** Keyed by document, so one node read under two documents is read against each. */
  private readonly documents = new Map<JsonSchemaNode, DocumentState>();

  constructor(private readonly conversion: SchemaConversion) {}

  /**
   * `base` is the object `pointer` is relative to: the node a descent began at, or the
   * document a reference resolved against.
   */
  read(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
    arrivedBy: string | undefined,
  ): Read {
    // `false` admits no value; any other non-object says nothing, so there is nothing to judge.
    if (node === (false as unknown)) return { ...this.nodeRead(DYN, base, pointer, NO_SCHEMA_READS), none: { keywords: [] } };
    if (typeof node !== "object" || node === null) return this.nodeRead(DYN, base, pointer, NO_SCHEMA_READS);
    const state = this.documentState(root);
    const held = state.done.get(node);
    if (held) return held;
    if (state.active.has(node)) {
      this.recursive.push({
        pointer,
        ...(through === undefined ? {} : { throughReference: through }),
        ...(arrivedBy === undefined ? {} : { reference: arrivedBy }),
      });
      return this.nodeRead(DYN, base, pointer, NO_SCHEMA_READS);
    }
    state.active.add(node);
    let read: Read;
    try {
      const own = this.readNode(node, root, base, pointer, through);
      read = this.nodeRead(own.type, base, pointer, own.reads, own.node);
      if (own.none) read = { ...read, none: own.none };
      if (own.values) read = { ...read, values: own.values };
    } finally {
      state.active.delete(node);
    }
    // A union a meet built is the conversion's one copy of it, which containers hold: this node
    // places its own.
    if (read.type.kind === "union" && this.answers.metUnions.has(read.type)) {
      read = { ...read, type: { kind: "union", members: read.type.members } };
    }
    // A union this node built itself — a `type` list, an `enum`, an intersection — holds
    // every member as read from this node.
    if (read.type.kind === "union" && !this.unionNodes.has(read.type)) {
      this.unionNodes.set(read.type, read.type.members.map(() => read.node));
    }
    state.done.set(node, read);
    return read;
  }

  /** {@link joinedReads}, counting what a joined reading holds. */
  joined(parts: readonly SchemaReads[]): SchemaReads {
    const reads = joinedReads(parts);
    if (reads.parts && !parts.includes(reads)) this.readsEntries += reads.parts.length;
    return reads;
  }

  /** {@link nodeRead}, counting the node it reads. */
  private nodeRead(type: CelType, document: JsonSchemaNode, pointer: string, reads: SchemaReads, from?: SchemaDependency): Read {
    this.readsEntries += 1;
    return nodeRead(type, document, pointer, reads, from);
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
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): OwnRead {
    const answer = this.conversion.resolveSchemaType?.({ node, root });
    if (answer && "document" in answer) {
      // The host answered a document: the descent crosses into it, and a pointer from
      // here on is within that document. The reference that first left the conversion's
      // own document is what a consumer anchors at, so the first crossing is the one kept.
      const crossed = answer.document;
      return this.read(crossed.node, crossed.root ?? crossed.node, crossed.node, "", through ?? pointer, undefined);
    }
    if (answer) {
      const type = this.conversion.lookupNamedType?.(answer.name, answer.args ?? []);
      if (type) return { type, reads: NO_SCHEMA_READS };
      // The host named a type that is neither CEL's nor registered — its own disagreement with itself.
      // Falling through to the structural rules is the right READING, but doing it quietly
      // is the same silence this report exists to end, so it is reported beside that reading.
      this.report(pointer, through, [], "named-type-unregistered", answer.name);
    }
    this.reportUnreadKeywords(node, pointer, through);
    const met = this.meet(this.parts(node, root, base, pointer, through), pointer, through);
    const read = node.not === undefined ? met : this.negated(node.not, met, base, pointer, through);
    // `not` takes no value out of a finite set: a set wider than the node admits is still sound.
    const values = intersectValues([met.values, ownValues(node)]);
    return values === undefined ? read : { ...read, values };
  }

  /**
   * What `not` takes out of the type the rest of the node says: every value (`{}`, `true`),
   * nothing (`false`, or a subschema constraining only values), or each union member the
   * subschema accepts wholly. A subschema saying more about a type is not read.
   */
  private negated(
    negation: boolean | JsonSchemaNode,
    own: OwnRead,
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): OwnRead {
    if (own.none || negation === false) return own;
    const reads = this.joined([own.reads, this.nodeRead(DYN, base, `${pointer}/not`, NO_SCHEMA_READS).reads]);
    if (negation === true || (isSchemaObject(negation) && admitsEveryValue(negation))) {
      return { type: DYN, reads, none: { keywords: ["not"] } };
    }
    if (!isSchemaObject(negation)) return { ...own, reads };
    const typeKeywords = TYPE_CONSTRAINING_KEYWORDS.filter((keyword) => keyword in negation);
    if (typeKeywords.some((keyword) => !NEGATION_TYPE_KEYWORDS.includes(keyword))) {
      this.report(pointer, through, ["not"], "shape-not-read");
      return { ...own, reads };
    }
    if (isDyn(own.type)) return { ...own, reads };
    const members = own.type.kind === "union" ? own.type.members : [own.type];
    const kept = members.filter((member) => !acceptsWholly(negation, member));
    if (kept.length === members.length) return { ...own, reads };
    if (kept.length === 0) return { type: DYN, reads, none: { keywords: ["not"] } };
    const type = unionOf(kept);
    // A member kept is still read from the node it was read from.
    const nodes = own.type.kind === "union" ? this.unionNodes.get(own.type) : undefined;
    const nodeOf = (member: CelType) => (nodes ? nodes[members.indexOf(member)] : own.node);
    if (type.kind === "union") {
      if (nodes) this.unionNodes.set(type, type.members.map((member) => nodeOf(member)!));
      return { type, reads, ...(own.node ? { node: own.node } : {}) };
    }
    const node = nodeOf(type);
    return { type, reads, ...(node ? { node } : {}) };
  }

  /**
   * A meeting of this conversion's types. `compared` collects what it compares: at every member
   * position several parts hold, the reads of each part holding it as `dyn`, and where several
   * parts type it other than `dyn`, the reads of each of those. `limit` is marked where a union
   * meet would build more members than {@link UNION_EXPANSION_LIMIT}.
   */
  private meeting(compared: SchemaReads[], limit: MeetLimit): Meeting {
    return new Meeting(this.answers, { reader: this, compared, limit }, 0);
  }

  /** What a meeting of `first` and `second` compares at `keys`, pushed onto `compared`. */
  compare(compared: SchemaReads[], first: CelType, second: CelType, keys: readonly MemberPosition[]): void {
    for (const key of keys) {
      const held = this.heldByBoth(first, second, key);
      if (held.length < 2) continue;
      const typed = held.filter((holder) => holder.typed).length;
      for (const holder of held) if (!holder.typed || typed > 1) compared.push(holder.reads);
    }
  }

  /** A site's meet past the limit, reported at its node and read as {@link joinedMembers} of what it met. */
  private joinedPastLimit(types: readonly CelType[], pointer: string, through: string | undefined, keywords: readonly string[]): CelType {
    this.report(pointer, through, keywords, "shape-not-read");
    return joinedMembers(types);
  }

  /**
   * Where a container an intersection built reads each member from. A member exactly one part
   * types other than `dyn` — one held as `dyn` alone, where no part types it — is read from
   * that part's node; one several parts type was built by the intersection and is read from
   * none, its reads every one of theirs. A member declared absent is read from the first part
   * declaring it so, and one the meet made absent from none, its reads every part's typing it.
   * `positions` names what a member of a record built from both sides' pattern parts stands on.
   */
  place<T extends CelType>(built: T, first: CelType, second: CelType, positions?: ReadonlyMap<EdgeKey, MemberPosition>): T {
    const members = new Map<EdgeKey, readonly Holder[]>();
    const absent = new Map<string, readonly Holder[]>();
    // Per member declared absent, whether some part declares it so.
    const declared = new Set<string>();
    // Every member and absent name, in the order their reads are kept.
    const order: EdgeKey[] = [];
    const member = (key: EdgeKey, position: MemberPosition = positions?.get(key) ?? key) => {
      members.set(key, this.heldByBoth(first, second, position));
      order.push(key);
    };
    switch (built.kind) {
      case "record":
        for (const name of built.fields.keys()) member(name);
        for (const name of built.absentFields ?? []) {
          const declaring = canonicalHolders([...this.absentHolders(first, name), ...this.absentHolders(second, name)]);
          // A member no part declares absent is one whose meet cannot hold: read from every part typing it.
          absent.set(name, declaring.length > 0 ? declaring : this.heldByBoth(first, second, name));
          if (declaring.length > 0) declared.add(name);
          order.push(name);
        }
        if (built.additionalFields !== undefined) member(ADDITIONAL_EDGE);
        for (const [part, held] of (built.patternParts ?? []).entries()) {
          for (const at of held.fields.keys()) member(patternEdge(part, at));
          if (held.additionalFields !== undefined) member(partAdditionalEdge(part));
        }
        break;
      case "map":
        member(ELEMENT_EDGE);
        break;
      case "list":
        if (!built.prefixElements) member(ELEMENT_EDGE);
        else {
          for (const at of built.prefixElements.keys()) member(String(at));
          if (built.additionalElements !== undefined) member(ADDITIONAL_EDGE);
        }
        break;
      case "optional":
        break;
      default:
        return built;
    }
    // Two meets building what their readers cannot tell apart answer one container.
    const key = this.containerKey(built, members, absent, declared);
    const held = this.containers.get(key);
    if (held) return held as T;
    this.containers.set(key, built);
    if (built.kind === "optional") return built;
    const edges = new Map<EdgeKey, SchemaReads>();
    const nodes = new Map<EdgeKey, SchemaDependency>();
    for (const key of order) {
      const held = members.get(key);
      if (held === undefined) {
        const declaring = absent.get(key as string)!;
        if (declared.has(key as string) && declaring[0]!.node) nodes.set(key, declaring[0]!.node);
        edges.set(key, this.joined(declaring.map((holder) => holder.reads)));
        continue;
      }
      const typed = held.filter((holder) => holder.typed);
      const standing = typed.length > 0 ? typed : held;
      if (standing.length === 1 && standing[0]!.node) nodes.set(key, standing[0]!.node);
      edges.set(key, this.joined(standing.map((holder) => holder.reads)));
    }
    // A tuple's element is every position and the rest at once, built by the intersection.
    if (built.kind === "list" && built.prefixElements) edges.set(ELEMENT_EDGE, this.joined([...edges.values()]));
    for (const held of [...members.values(), ...absent.values()]) this.heldHolders += held.length;
    this.builtContainers += 1;
    this.declaring.set(built, { members, absent });
    this.edges.set(built, edges);
    this.memberNodes.set(built, nodes);
    return built;
  }

  /** A union a meet built, kept once by its members' identities. */
  union(built: UnionType): UnionType {
    const key = `u${built.members.map((member) => this.identity(member)).join(",")}`;
    const held = this.containers.get(key);
    if (held) return held as UnionType;
    this.containers.set(key, built);
    return built;
  }

  private identity(value: unknown): number {
    let held = this.identities.get(value);
    if (held === undefined) this.identities.set(value, (held = this.identities.size));
    return held;
  }

  /**
   * Everything a reader observes of a container a meet built: its kind, each member's type by
   * identity, a record's name, sets, absent names and pattern texts, and each member's holders —
   * an absent one's marked where a part declares it so, since only then is it placed.
   */
  private containerKey(
    built: CelType,
    members: ReadonlyMap<EdgeKey, readonly Holder[]>,
    absent: ReadonlyMap<string, readonly Holder[]>,
    declared: ReadonlySet<string>,
  ): string {
    const id = (value: unknown) => this.identity(value);
    const type = (member: CelType | undefined) => (member === undefined ? "-" : String(id(member)));
    const edge = (key: EdgeKey) => (typeof key === "string" ? JSON.stringify(key) : `#${id(key)}`);
    const holders = (map: ReadonlyMap<EdgeKey, readonly Holder[]>) =>
      [...map].map(([key, held]) => `${typeof key === "string" && declared.has(key) ? "!" : ""}${edge(key)}=${held.map(id).join(",")}`).join(";");
    let shape: string;
    switch (built.kind) {
      case "record": {
        const fields = [...built.fields].map(([name, member]) => {
          const values = built.fieldEnums?.get(name);
          return `${JSON.stringify(name)}:${type(member)}${values ? `{${values.map((value) => `${typeof value}:${String(value)}`).join(",")}}` : ""}`;
        });
        const parts = (built.patternParts ?? []).map(
          (part) => `[${part.fields.map((entry) => `${JSON.stringify(entry.pattern)}:${type(entry.type)}`).join(",")}|${type(part.additionalFields)}]`,
        );
        shape = `r${built.name === undefined ? "" : JSON.stringify(built.name)}(${fields.join(",")})${JSON.stringify([...(built.absentFields ?? [])])}${type(built.additionalFields)}${parts.join("")}`;
        break;
      }
      case "map":
        shape = `m${type(built.key)},${type(built.value)}`;
        break;
      case "list":
        shape = built.prefixElements ? `t${built.prefixElements.map(type).join(",")}|${type(built.additionalElements)}` : `l${type(built.element)}`;
        break;
      case "optional":
        shape = `o${type(built.value)}`;
        break;
      default:
        throw new Error(`a meet builds no ${built.kind} container`);
    }
    return `${shape}/${holders(members)}/${holders(absent)}`;
  }

  /** Both sides' holders of the member at `position`, first side first, canonical ({@link canonicalHolders}). */
  private heldByBoth(first: CelType, second: CelType, position: MemberPosition): readonly Holder[] {
    return canonicalHolders([...this.holders(first, position, 0), ...this.holders(second, position, 1)]);
  }

  /**
   * The parts of one side of an intersection holding the member at `position`: a declared
   * member, each pattern matching it, or the undeclared members, element or rest standing for
   * it — or, for a position naming what each side stands on, side `which`'s. A side an earlier
   * meeting built stands for every part it was built from.
   */
  private holders(side: CelType, position: MemberPosition, which: 0 | 1): readonly Holder[] {
    const held = typeof position === "object" ? position.sides[which] : membersAt(side, position);
    if (held.length === 0) return NO_HOLDERS;
    const declared = this.declaring.get(side);
    if (declared) return held.flatMap(([edge]) => declared.members.get(edge) ?? NO_HOLDERS);
    return held.map(([edge, type]) => this.holder(side, edge, !isDyn(type)));
  }

  private holder(side: CelType, edge: EdgeKey, typed: boolean): Holder {
    let bySide = this.holderTable.get(side);
    if (!bySide) this.holderTable.set(side, (bySide = new Map()));
    let byEdge = bySide.get(edge);
    if (!byEdge) bySide.set(edge, (byEdge = [undefined, undefined]));
    const at = typed ? 1 : 0;
    return (byEdge[at] ??= {
      node: this.memberNodes.get(side)?.get(edge),
      reads: this.edges.get(side)?.get(edge) ?? NO_SCHEMA_READS,
      typed,
    });
  }

  /** The parts of one side declaring a member absent: its own absent name, or each pattern admitting no value that matches it. */
  private absentHolders(side: CelType, name: string): readonly Holder[] {
    if (side.kind !== "record") return NO_HOLDERS;
    const declared = this.declaring.get(side);
    if (side.absentFields?.has(name)) {
      if (declared) return declared.absent.get(name) ?? NO_HOLDERS;
      return [this.holder(side, name, false)];
    }
    if (side.fields.has(name)) return NO_HOLDERS;
    return (patternStanding(side, name) ?? [])
      .filter((held) => held.type === undefined)
      .flatMap((held) => (declared ? declared.members.get(held.edge) ?? NO_HOLDERS : [this.holder(side, held.edge, false)]));
  }

  /** A reading of types read whole. */
  private wholeReads(whole: readonly WholeRead[]): SchemaReads {
    this.readsEntries += whole.length;
    return { nodes: [], whole };
  }

  reportNoValue(pointer: string, none: NoValue): void {
    this.report(pointer, undefined, none.keywords, "intersection-empty");
  }

  /** Everything the node says about its own type, each with the keyword that said it. */
  private parts(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): readonly TypePart[] {
    const parts: TypePart[] = [];
    if (typeof node.$ref === "string") {
      parts.push({ keyword: "$ref", ...this.reference(node.$ref, root, pointer, through) });
    }
    if (node.allOf && node.allOf.length > 0) {
      const branches = node.allOf.map((branch, at) => ({
        keyword: "allOf",
        ...this.read(branch, root, base, `${pointer}/allOf/${at}`, through, undefined),
      }));
      parts.push({ keyword: "allOf", ...this.meet(branches, pointer, through) });
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!branches || branches.length === 0) continue;
      parts.push({
        keyword,
        ...this.unionRead(
          branches.map((branch, at) => this.read(branch, root, base, `${pointer}/${keyword}/${at}`, through, undefined)),
          keyword,
        ),
      });
    }
    if (node.if !== undefined) parts.push(this.conditional(node, root, base, pointer, through));
    const structural = this.structure(node, root, base, pointer, through);
    if (structural) parts.push({ ...structural, reads: NO_SCHEMA_READS });
    return parts;
  }

  /**
   * `if` / `then` / `else` as one part: the union of `if` met with `then` (`{}` where absent)
   * and `else`, a branch that cannot hold dropped; with no `else` it says nothing. The three
   * nodes are read whole, since the answer rests on all of them.
   */
  private conditional(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): TypePart {
    const branch = (keyword: string) =>
      node[keyword] === undefined
        ? undefined
        : this.read(node[keyword] as JsonSchemaNode, root, base, `${pointer}/${keyword}`, through, undefined);
    const condition = branch("if")!;
    const then = branch("then");
    const otherwise = branch("else");
    const reads = this.wholeReads(
      [condition, then, otherwise].filter((read): read is Read => read !== undefined).map((read) => ({ type: read.type, reads: read.reads })),
    );
    if (!otherwise) return { keyword: "if", type: DYN, reads };
    const limit: MeetLimit = { past: false };
    let holding =
      condition.none || then?.none ? undefined : then ? intersectTypes(condition.type, then.type, this.meeting([], limit)) : condition.type;
    if (limit.past) holding = this.joinedPastLimit([condition.type, then!.type], pointer, through, ["if", "then"]);
    const kept = [holding, otherwise.none ? undefined : otherwise.type].filter((type): type is CelType => type !== undefined);
    if (kept.length === 0) return { keyword: "if", type: DYN, reads, none: { keywords: ["else", "if", "then"] } };
    return { keyword: "if", type: unionOf(kept), reads };
  }

  /** What `type`, `properties`, `items` or a constant value say, in that order. */
  private structure(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): { readonly keyword: string; readonly type: CelType } | undefined {
    if (Array.isArray(node.type)) {
      return {
        keyword: "type",
        type: unionOf(node.type.map((name) => this.ofType(name, node, root, base, pointer, through))),
      };
    }
    if (typeof node.type === "string") {
      return { keyword: "type", type: this.ofType(node.type, node, root, base, pointer, through) };
    }
    if (node.properties || node.additionalProperties !== undefined || isSchemaObject(node.patternProperties)) {
      return { keyword: "properties", type: this.record(node, root, base, pointer, through) };
    }
    if (node.items !== undefined || node.prefixItems !== undefined) {
      return { keyword: "items", type: this.array(node, root, base, pointer, through) };
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
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    const scalar = SCALARS[name];
    if (scalar) return scalar;
    if (name === "object") return this.record(node, root, base, pointer, through);
    if (name === "array") return this.array(node, root, base, pointer, through);
    this.report(pointer, through, ["type"], "shape-not-read");
    return DYN;
  }

  private record(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    const properties = node.properties;
    const additional = node.additionalProperties;
    const patternEntries = isSchemaObject(node.patternProperties) ? Object.entries(node.patternProperties) : [];
    // A pattern RE2 refuses could match any member: every member it does not declare is `dyn`.
    const patternsRead = patternEntries.every(([pattern]) => "pattern" in re2Pattern(pattern));
    if (!patternsRead) {
      this.report(pointer, through, ["patternProperties"], "shape-not-read");
      const fields = new Map<string, CelType>();
      const absent = new Set<string>();
      const enums = new Map<string, readonly FieldEnumValue[]>();
      const edges: [EdgeKey, Read][] = [];
      for (const [name, property] of Object.entries(properties ?? {})) {
        const read = this.read(property, root, base, `${pointer}/properties/${escapeSegment(name)}`, through, undefined);
        if (read.none) absent.add(name);
        else declareField(name, read.type, read.values, fields, absent, enums);
        edges.push([name, read]);
      }
      return this.withEdges(recordOf(fields, DYN, absent, undefined, undefined, enums), edges);
    }
    const additionalRead =
      additional === undefined || typeof additional === "boolean"
        ? undefined
        : this.read(additional, root, base, `${pointer}/additionalProperties`, through, undefined);
    // A schema there admitting no value says what `false` does; its node is still read.
    const additionalEdge: [EdgeKey, Read][] = additionalRead ? [[ADDITIONAL_EDGE, additionalRead]] : [];
    if (!properties && patternEntries.length === 0) {
      // No declared property: a schema that says what any value is, is a map of it; one
      // that admits anything is a map of anything; one that admits nothing holds no field.
      if (additionalRead && !additionalRead.none) {
        return this.withEdges(mapOf(STRING, additionalRead.type), [[ELEMENT_EDGE, additionalRead]]);
      }
      if (additional === false || additionalRead) return this.withEdges(recordOf(new Map()), additionalEdge);
      return mapOf(STRING, DYN);
    }
    const propertyReads = Object.entries(properties ?? {}).map(
      ([name, property]) =>
        [name, this.read(property, root, base, `${pointer}/properties/${escapeSegment(name)}`, through, undefined)] as const,
    );
    const patterns = patternEntries.map(
      ([pattern, schema]) =>
        [pattern, this.read(schema as JsonSchemaNode, root, base, `${pointer}/patternProperties/${escapeSegment(pattern)}`, through, undefined)] as const,
    );
    // One schema node is one pattern part, with no undeclared members of its own.
    const parts: PatternPart[] =
      patterns.length === 0 ? [] : [{ fields: patterns.map(([pattern, read]) => (read.none ? { pattern } : { pattern, type: read.type })) }];
    const patternRecord = recordOf(new Map(), undefined, undefined, undefined, parts);
    const fields = new Map<string, CelType>();
    const absent = new Set<string>();
    const enums = new Map<string, readonly FieldEnumValue[]>();
    const edges: [EdgeKey, MemberRead][] = [];
    for (const [name, read] of propertyReads) {
      const matched = read.none ? [] : partMatches(patternRecord, name)?.[0] ?? [];
      if (matched.length === 0) {
        // A member whose schema admits no value is declared absent.
        if (read.none) absent.add(name);
        else declareField(name, read.type, read.values, fields, absent, enums);
        edges.push([name, read]);
        continue;
      }
      // Each pattern matching a declared member applies to it with its `properties` entry.
      const applying = [read, ...matched.map((at) => patterns[at]![1])];
      const empty = applying.find((part) => part.none);
      if (empty) {
        absent.add(name);
        edges.push([name, { reads: this.joined(applying.map((part) => part.reads)), node: empty.node }]);
        continue;
      }
      const compared: SchemaReads[] = [];
      const limit: MeetLimit = { past: false };
      let met = applying.slice(1).reduce<CelType | undefined>(
        (held, part) => (held === undefined ? undefined : intersectTypes(held, part.type, this.meeting(compared, limit))),
        read.type,
      );
      if (limit.past) {
        met = this.joinedPastLimit(
          applying.map((part) => part.type),
          pointer,
          through,
          ["patternProperties"],
        );
      }
      if (met === undefined) absent.add(name);
      else declareField(name, met, read.values, fields, absent, enums);
      edges.push([name, { reads: this.joined([...applying.map((part) => part.reads), ...compared]) }]);
    }
    const additionalFields =
      additional === true ? DYN : additionalRead && !additionalRead.none ? additionalRead.type : undefined;
    const patternEdges = patterns.map(([, read], at): [EdgeKey, Read] => [patternEdge(0, at), read]);
    return this.withEdges(recordOf(fields, additionalFields, absent, undefined, parts, enums), [...edges, ...additionalEdge, ...patternEdges]);
  }

  private array(
    node: JsonSchemaNode,
    root: JsonSchemaNode,
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    const items = node.items;
    const prefixItems = node.prefixItems;
    if (prefixItems !== undefined) {
      // 2020-12 spells a tuple `prefixItems` + `items`; draft-07's rest keyword beside it, or
      // a draft-07 tuple, leaves the positions unsaid.
      const mixed = [
        ...(node.additionalItems !== undefined ? ["additionalItems"] : []),
        ...(Array.isArray(items) ? ["items"] : []),
        ...(Array.isArray(prefixItems) ? [] : ["prefixItems"]),
      ];
      if (mixed.length > 0) {
        this.report(pointer, through, ["prefixItems", ...mixed], "shape-not-read");
        return listOf(DYN);
      }
      return this.tuple(prefixItems, "prefixItems", items as boolean | JsonSchemaNode | undefined, "items", root, base, pointer, through);
    }
    if (Array.isArray(items)) {
      return this.tuple(items, "items", node.additionalItems, "additionalItems", root, base, pointer, through);
    }
    if (items === undefined) return listOf(DYN);
    const read = this.read(items as JsonSchemaNode, root, base, `${pointer}/items`, through, undefined);
    // An element admitting no value is a list that holds none.
    if (read.none) return this.withEdges(tupleOf([]), [[ADDITIONAL_EDGE, read]]);
    return this.withEdges(listOf(read.type), [[ELEMENT_EDGE, read]]);
  }

  /**
   * A tuple: each position read in turn, then the rest — `dyn` where its keyword is absent,
   * none where it admits no value. A position admitting no value ends the tuple there.
   */
  private tuple(
    positions: readonly (boolean | JsonSchemaNode)[],
    positionsKeyword: string,
    rest: boolean | JsonSchemaNode | undefined,
    restKeyword: string,
    root: JsonSchemaNode,
    base: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): CelType {
    const prefix: CelType[] = [];
    const held: Read[] = [];
    const edges: [EdgeKey, MemberRead][] = [];
    let ended = false;
    for (const [at, position] of positions.entries()) {
      const read = this.read(position as JsonSchemaNode, root, base, `${pointer}/${positionsKeyword}/${at}`, through, undefined);
      edges.push([String(at), read]);
      if (read.none) {
        ended = true;
        break;
      }
      prefix.push(read.type);
      held.push(read);
    }
    let restType: CelType | undefined;
    if (!ended) {
      if (rest === undefined) restType = DYN;
      else {
        const read = this.read(rest as JsonSchemaNode, root, base, `${pointer}/${restKeyword}`, through, undefined);
        edges.push([ADDITIONAL_EDGE, read]);
        if (!read.none) {
          restType = read.type;
          held.push(read);
        }
      }
    }
    const list = tupleOf(prefix, restType);
    // The element is every position and the rest at once: a read of it lists each of their nodes.
    const element: MemberRead = {
      reads: this.joined(edges.map(([, member]) => member.reads)),
      ...(held.length === 1 ? { node: held[0]!.node } : {}),
    };
    if (list.element.kind === "union") {
      this.unionNodes.set(list.element, list.element.members.map((member) => this.branchNode(held, member)!));
    }
    return this.withEdges(list, [...edges, [ELEMENT_EDGE, element]]);
  }

  /** A container type this conversion built: each member's reads, and the node it was read from. */
  private withEdges(type: CelType, members: readonly (readonly [EdgeKey, MemberRead])[]): CelType {
    this.edges.set(type, new Map(members.map(([key, member]) => [key, member.reads])));
    const nodes = new Map<EdgeKey, SchemaDependency>();
    for (const [key, member] of members) if (member.node) nodes.set(key, member.node);
    this.memberNodes.set(type, nodes);
    return type;
  }

  /**
   * A union of branches. A branch the union kept is read as a member; one it dropped as equal
   * to another, or that a `dyn` absorbed, is read whole — the union's answer rests on it.
   * Each member is read from the first branch holding it, and a union that kept one branch's
   * type alone was read from that branch.
   */
  private unionRead(read: readonly Read[], keyword: string): OwnRead {
    // A branch admitting no value is no alternative.
    const branches = read.filter((branch) => !branch.none);
    if (branches.length === 0) {
      return { type: DYN, reads: this.joined(read.map((branch) => branch.reads)), none: { keywords: [keyword] } };
    }
    const type = unionOf(branches.map((branch) => branch.type));
    const kept: SchemaReads[] = [];
    const whole: { type: CelType; reads: SchemaReads }[] = [];
    for (const branch of branches) {
      if (keptIn(type, branch.type)) kept.push(branch.reads);
      else whole.push({ type: branch.type, reads: branch.reads });
    }
    const dropped = read.filter((branch) => branch.none).map((branch) => branch.reads);
    const joined = this.joined([...kept, ...dropped]);
    const reads = whole.length === 0 ? joined : this.joined([joined, this.wholeReads(whole)]);
    // A union of finite sets is finite; one branch that is not makes the union not.
    const finite = branches.every((branch) => branch.values !== undefined);
    const values = finite ? { values: unitedValues(branches.map((branch) => branch.values!)) } : {};
    if (type.kind !== "union") {
      const held = branches.find((branch) => branch.type === type);
      return { type, reads, ...(held ? { node: held.node } : {}), ...values };
    }
    this.unionNodes.set(type, type.members.map((member) => this.branchNode(branches, member)!));
    return { type, reads, ...values };
  }

  /** The node the first branch holding a member read it from. */
  private branchNode(branches: readonly Read[], member: CelType): SchemaDependency | undefined {
    for (const branch of branches) {
      if (branch.type === member) return branch.node;
      if (branch.type.kind !== "union") continue;
      const at = branch.type.members.indexOf(member);
      if (at >= 0) return this.unionNodes.get(branch.type)?.[at] ?? branch.node;
    }
    return undefined;
  }

  /** A document-local reference, resolved here; anything else was the host's to answer. */
  private reference(
    reference: string,
    root: JsonSchemaNode,
    pointer: string,
    through: string | undefined,
  ): OwnRead {
    if (!reference.startsWith("#")) {
      // The host's resolver was asked at this node and did not answer it.
      this.report(pointer, through, ["$ref"], "reference-unresolved");
      return { type: DYN, reads: NO_SCHEMA_READS };
    }
    const target = nodeAtPointer(root, reference.slice(1));
    if (!target) {
      this.report(pointer, through, ["$ref"], "reference-unresolved");
      // Where it points is read all the same: a node appearing there would answer it. The
      // type is still read from the reference, since nothing stands where it points.
      return { type: DYN, reads: this.nodeRead(DYN, root, reference.slice(1), NO_SCHEMA_READS).reads };
    }
    return this.read(target, root, root, reference.slice(1), through, reference);
  }

  /**
   * The one type every part admits: records merge field-wise, a narrower scalar wins, and
   * two parts that cannot both hold admit no value — absence to the node's holder, reported
   * at a registration's root — rather than quietly resolved one way. One part reads what it
   * reads; an intersection of several reads each part's own type and what the meeting compared.
   */
  private meet(parts: readonly TypePart[], pointer: string, through: string | undefined): OwnRead {
    if (parts.length === 0) return { type: DYN, reads: NO_SCHEMA_READS };
    if (parts.length === 1) return parts[0]!;
    const compared: SchemaReads[] = [];
    const reads = () => this.joined([...parts.map((part) => part.reads), ...compared]);
    // A part admitting no value leaves nothing for the others to admit.
    const none = parts.find((part) => part.none)?.none;
    if (none) return { type: DYN, reads: reads(), none };
    const limit: MeetLimit = { past: false };
    const meeting = this.meeting(compared, limit);
    const values = intersectValues(parts.map((part) => part.values));
    let [keyword, type] = [parts[0]!.keyword, parts[0]!.type];
    for (const part of parts.slice(1)) {
      const both = intersectTypes(type, part.type, meeting);
      if (limit.past) break;
      if (!both) return { type: DYN, reads: reads(), none: { keywords: [keyword, part.keyword] } };
      [keyword, type] = [part.keyword, both];
    }
    if (limit.past) {
      const joined = this.joinedPastLimit(
        parts.map((part) => part.type),
        pointer,
        through,
        parts.map((part) => part.keyword),
      );
      return { type: joined, reads: this.joined(parts.map((part) => part.reads)), ...(values === undefined ? {} : { values }) };
    }
    return { type, reads: reads(), ...(values === undefined ? {} : { values }) };
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

/**
 * A node's type, read as that node: its own position, then what reading it continues into,
 * and the node the type was read from — `from`, or this one.
 */
function nodeRead(
  type: CelType,
  document: JsonSchemaNode,
  pointer: string,
  reads: SchemaReads,
  from?: SchemaDependency,
): Read {
  return { type, reads: { nodes: [{ document, pointer, reads }], whole: [] }, node: from ?? { document, pointer } };
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

/** The values a node's own `const` and `enum` admit, where every one is a scalar and some are listed. */
function ownValues(node: JsonSchemaNode): readonly JsonScalar[] | undefined {
  const lists: (readonly JsonScalar[] | undefined)[] = [];
  if ("const" in node) lists.push(scalars([node.const]));
  if (Array.isArray(node.enum)) lists.push(scalars(node.enum));
  return intersectValues(lists);
}

function scalars(values: readonly unknown[]): readonly JsonScalar[] | undefined {
  if (values.length === 0) return undefined;
  return values.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value))
    ? (values as readonly JsonScalar[])
    : undefined;
}

/** The values every finite set admits; nothing where no set is finite. */
function intersectValues(sets: readonly (readonly JsonScalar[] | undefined)[]): readonly JsonScalar[] | undefined {
  let held: readonly JsonScalar[] | undefined;
  for (const values of sets) {
    if (values === undefined) continue;
    held = held === undefined ? values : held.filter((value) => values.includes(value));
  }
  return held;
}

function unitedValues(sets: readonly (readonly JsonScalar[])[]): readonly JsonScalar[] {
  const united: JsonScalar[] = [];
  for (const values of sets) for (const value of values) if (!united.includes(value)) united.push(value);
  return united;
}

/**
 * A declared field and its set: a set no value of which survives the meet that built it makes
 * the field absent, and one its type reads no value of carries none.
 */
function declareField(
  name: string,
  type: CelType,
  values: readonly JsonScalar[] | undefined,
  fields: Map<string, CelType>,
  absent: Set<string>,
  enums: Map<string, readonly FieldEnumValue[]>,
): void {
  if (values !== undefined && values.length === 0) {
    absent.add(name);
    return;
  }
  fields.set(name, type);
  const typed = values === undefined ? [] : values.flatMap((value) => typedValue(value, type));
  if (typed.length > 0) enums.set(name, typed);
}

/** A written value as a field's type reads it: an integral number an int where the type holds one, else a double. */
function typedValue(value: JsonScalar, type: CelType): FieldEnumValue[] {
  if (value === null) return admitsScalar(type, "null") ? [null] : [];
  if (typeof value === "boolean") return admitsScalar(type, "bool") ? [value] : [];
  if (typeof value === "string") return admitsScalar(type, "string") ? [value] : [];
  if (Number.isInteger(value) && value >= -9223372036854775808 && value < 9223372036854775808 && admitsScalar(type, "int")) {
    return [BigInt(value)];
  }
  return admitsScalar(type, "double") ? [value] : [];
}

/** Whether a field's type holds values of a scalar type. */
function admitsScalar(type: CelType, name: "null" | "bool" | "string" | "int" | "double"): boolean {
  if (isDyn(type)) return true;
  if (type.kind === "union") return type.members.some((member) => admitsScalar(member, name));
  return type.kind === "primitive" && type.name === name;
}

/** A set's values the field's type still reads: an integral double read as an int where only an int is held, a value of another type dropped. */
function heldValues(values: readonly FieldEnumValue[], type: CelType): readonly FieldEnumValue[] {
  return values.flatMap((value) => {
    const read = readAs(value, type);
    return read === undefined ? [] : [read];
  });
}

/**
 * A set's value as a met field's type reads it: a double the type holds no double of is the
 * int it equals, where it is integral and the type holds an int; a value of another type is
 * nothing.
 */
function readAs(value: FieldEnumValue, type: CelType): FieldEnumValue | undefined {
  const name =
    value === null ? "null" : typeof value === "boolean" ? "bool" : typeof value === "string" ? "string" : typeof value === "bigint" ? "int" : "double";
  if (admitsScalar(type, name)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= -9223372036854775808 && value < 9223372036854775808 && admitsScalar(type, "int")) {
    return BigInt(value);
  }
  return undefined;
}

/**
 * The set of a field two sets meet at: each side's values the met type reads, then those both
 * admit; nothing where neither side carries one, and an empty set where none survives.
 */
function metFieldEnum(
  left: readonly FieldEnumValue[] | undefined,
  right: readonly FieldEnumValue[] | undefined,
  type: CelType,
): readonly FieldEnumValue[] | undefined {
  if (left === undefined && right === undefined) return undefined;
  const [held, other] = [left && heldValues(left, type), right && heldValues(right, type)];
  if (held === undefined || other === undefined) return (held ?? other)!;
  return held.filter((value) => other.some((also) => compareFieldEnumValues(value, also) === 0));
}

/**
 * A member position two containers meet at: a member's edge key, or what each side stands on
 * for a member a meeting built from both sides' pattern parts — per side, each edge and its type.
 */
type MemberPosition = EdgeKey | { readonly sides: readonly [MemberSources, MemberSources] };

type MemberSources = readonly (readonly [EdgeKey, CelType])[];

function swappedPosition(position: MemberPosition): MemberPosition {
  return typeof position === "object" ? { sides: [position.sides[1], position.sides[0]] } : position;
}

/** Which way round a meeting tells a conversion its sides: as written, swapped, or not at all. */
type MeetMode = 0 | 1 | 2;

/** Where one site's meetings report: its conversion, what they compared, and whether one went past the limit. */
interface MeetSite {
  readonly reader: SchemaReader;
  readonly compared: SchemaReads[];
  readonly limit: MeetLimit;
}

/** Whether a site's meeting went past the limit. */
interface MeetLimit {
  past: boolean;
}

/**
 * What a conversion is told of each container meeting, with the two sides in the order their
 * parts were written — a meeting that takes the right side first tells it {@link swapped}:
 * the member positions it is about to meet (`compare`), and the container it built (`place`,
 * answering the one container the conversion keeps for it), with what each member of a record
 * met from pattern parts stands on. A meeting with no site is observed by nothing.
 */
class Meeting {
  readonly swapped: Meeting;

  constructor(
    readonly answers: MeetAnswers,
    readonly site: MeetSite | undefined,
    readonly mode: MeetMode,
    twin?: Meeting,
  ) {
    this.swapped = twin ?? (site === undefined ? this : new Meeting(answers, site, mode === 0 ? 1 : 0, this));
  }

  compare(first: CelType, second: CelType, keys: readonly MemberPosition[]): void {
    const site = this.site;
    if (!site) return;
    if (this.mode === 1) site.reader.compare(site.compared, second, first, keys.map(swappedPosition));
    else site.reader.compare(site.compared, first, second, keys);
  }

  place<T extends CelType>(built: T, first: CelType, second: CelType, positions?: ReadonlyMap<EdgeKey, MemberPosition>): T {
    const site = this.site;
    if (!site) return built;
    if (this.mode === 0) return site.reader.place(built, first, second, positions);
    return site.reader.place(built, second, first, positions && new Map([...positions].map(([key, position]) => [key, swappedPosition(position)])));
  }

  /** The union a meet built, as the one the conversion keeps for its members. */
  union(built: CelType): CelType {
    return this.site && built.kind === "union" ? this.site.reader.union(built) : built;
  }

  /** A union meet would have built more members than {@link UNION_EXPANSION_LIMIT}. */
  pastLimit(): void {
    if (this.site) this.site.limit.past = true;
  }
}

/** One meet's answer: the type, or none where the sides cannot both hold; everything it compared, as one reading; whether it went past the limit. */
interface MeetAnswer {
  readonly type: CelType | undefined;
  readonly compared: SchemaReads;
  readonly past: boolean;
}

/**
 * The meets one conversion has answered, per mode by the identities of the two sides — a meet
 * is a function of its two types and the conversion's tables, so the same pair met again is
 * answered from here, its comparison replayed as the one reading it recorded.
 */
class MeetAnswers {
  private readonly held: Map<CelType, Map<CelType, MeetAnswer>>[] = [new Map(), new Map(), new Map()];
  readonly quiet: Meeting = new Meeting(this, undefined, 2);
  /** The unions a meet built rather than answered as a side. */
  readonly metUnions = new Set<CelType>();

  get(mode: MeetMode, left: CelType, right: CelType): MeetAnswer | undefined {
    return this.held[mode]!.get(left)?.get(right);
  }

  set(mode: MeetMode, left: CelType, right: CelType, answer: MeetAnswer): void {
    const byMode = this.held[mode]!;
    let row = byMode.get(left);
    if (!row) byMode.set(left, (row = new Map()));
    if (!row.has(right)) row.set(right, answer);
  }
}

function swapped(meeting: Meeting): Meeting {
  return meeting.swapped;
}

/** The one type both admit, or nothing when they cannot both hold — the conversion's meet, outside a conversion. */
export function meetTypes(left: CelType, right: CelType): CelType | undefined {
  return intersectTypes(left, right, new MeetAnswers().quiet);
}

/** The kinds two of which meet member by member even where they are equal; a union pairs instead. */
const MEMBERWISE_KINDS: ReadonlySet<CelType["kind"]> = new Set(["record", "map", "list", "optional"]);

/** Whether a meet of the two is answered from the conversion's table: two containers, or a union. */
function answeredOnce(left: CelType, right: CelType): boolean {
  return left.kind === "union" || right.kind === "union" || (MEMBERWISE_KINDS.has(left.kind) && MEMBERWISE_KINDS.has(right.kind));
}

/**
 * The one type both admit, or nothing when they cannot both hold.
 *
 * `undefined` is "no value satisfies both" — a scalar against a scalar, a union none of whose
 * members meet, an optional whose value cannot. Two containers always meet: a member position
 * that cannot hold is absence there (an absent field, a pattern entry admitting no value,
 * undeclared members closed, a list holding no element, a map holding no entry). Two
 * containers meet member by member even where they are equal, and two equal unions member by
 * member at matching positions, so each member is declared by both sides and built by the
 * intersection, and the met type equals each side's.
 *
 * Two containers or a union are met once per conversion and mode: met again, the pair answers
 * what it answered, its comparison pushed where the meet would have pushed it and its passing
 * of the limit marked again. With the containers a meet builds kept once by what their readers
 * observe, `(X∧X)∧(X∧X)` meets pairs met before and answers `X∧X`, its key being `X∧X`'s.
 */
function intersectTypes(left: CelType, right: CelType, meeting: Meeting): CelType | undefined {
  countTypeVisit();
  if (isDyn(left)) return right;
  if (isDyn(right)) return left;
  if (!answeredOnce(left, right)) return meetOnce(left, right, meeting);
  const answers = meeting.answers;
  const held = answers.get(meeting.mode, left, right);
  const site = meeting.site;
  if (held) {
    if (site) {
      if (held.compared !== NO_SCHEMA_READS) site.compared.push(held.compared);
      if (held.past) site.limit.past = true;
    }
    return held.type;
  }
  const from = site?.compared.length ?? 0;
  const outer = site?.limit.past ?? false;
  if (site) site.limit.past = false;
  const type = meetOnce(left, right, meeting);
  let compared = NO_SCHEMA_READS;
  let past = false;
  if (site) {
    compared = site.reader.joined(site.compared.splice(from));
    if (compared !== NO_SCHEMA_READS) site.compared.push(compared);
    past = site.limit.past;
    site.limit.past = outer || past;
  }
  answers.set(meeting.mode, left, right, { type, compared, past });
  if (type?.kind === "union" && type !== left && type !== right) answers.metUnions.add(type);
  return type;
}

function meetOnce(left: CelType, right: CelType, meeting: Meeting): CelType | undefined {
  if (isDyn(left)) return right;
  if (isDyn(right)) return left;
  if (left.kind === "union" || right.kind === "union") {
    // Two equal unions meet member by member at matching positions, the pairing their equality fixes.
    if (left.kind === "union" && right.kind === "union" && typesEqual(left, right)) {
      const paired = left.members
        .map((member, at) => intersectTypes(member, right.members[at]!, meeting))
        .filter((member): member is CelType => member !== undefined);
      return paired.length === 0 ? undefined : meeting.union(unionOf(paired));
    }
    const union = (left.kind === "union" ? left : right) as UnionType;
    const other = left.kind === "union" ? right : left;
    // Distributed, the meet would build a member per pair: past the limit it stands as the join.
    if (union.members.length * (other.kind === "union" ? other.members.length : 1) > UNION_EXPANSION_LIMIT) {
      meeting.pastLimit();
      return joinedMembers([left, right]);
    }
    // The union's member is met first, so a union on the right meets in reverse.
    const inOrder = left.kind === "union" ? meeting : swapped(meeting);
    const met = union.members
      .map((member) => intersectTypes(member, other, inOrder))
      .filter((member): member is CelType => member !== undefined);
    return met.length === 0 ? undefined : meeting.union(unionOf(met));
  }
  const memberwise = MEMBERWISE_KINDS.has(left.kind) && MEMBERWISE_KINDS.has(right.kind);
  if (!memberwise && typesEqual(left, right)) return left;
  if (left.kind === "record" && right.kind === "record") return intersectRecords(left, right, meeting);
  if (left.kind === "record" && right.kind === "map") {
    meeting.compare(left, right, recordKeys(left));
    return placed(intersectRecordWithMap(left, right.value, meeting), left, right, meeting);
  }
  if (right.kind === "record" && left.kind === "map") {
    meeting.compare(left, right, recordKeys(right));
    return placed(intersectRecordWithMap(right, left.value, swapped(meeting)), left, right, meeting);
  }
  if (left.kind === "map" && right.kind === "map") {
    meeting.compare(left, right, [ELEMENT_EDGE]);
    const key = intersectTypes(left.key, right.key, meeting);
    if (!key) return undefined;
    const value = intersectTypes(left.value, right.value, meeting);
    // A map whose value admits nothing holds no entry.
    return placed(value ? mapOf(key, value) : recordOf(new Map()), left, right, meeting);
  }
  if (left.kind === "list" && right.kind === "list") return placed(intersectLists(left, right, meeting), left, right, meeting);
  if (left.kind === "optional" && right.kind === "optional") {
    const value = intersectTypes(left.value, right.value, meeting);
    return value ? placed({ kind: "optional", value }, left, right, meeting) : undefined;
  }
  // Whichever stands where the other is wanted is the narrower of the two.
  if (assignable(left, right)) return left;
  if (assignable(right, left)) return right;
  // JSON Schema's `integer` is a `number`: an integer met with a double is the integer.
  if (isIntegral(left) && isDouble(right)) return left;
  if (isIntegral(right) && isDouble(left)) return right;
  return undefined;
}

/**
 * What a meet past {@link UNION_EXPANSION_LIMIT} stands as: the one type joining every member
 * of its operands, records of several shapes joining as a map — wider than the meet, so no
 * read the meet admits is refused.
 */
function joinedMembers(types: readonly CelType[]): CelType {
  const members = types.flatMap((type) => (type.kind === "union" ? type.members : [type]));
  return members.slice(1).reduce(unify, members[0]!);
}

function isIntegral(type: CelType): boolean {
  return type.kind === "primitive" && (type.name === "int" || type.name === "uint");
}

function isDouble(type: CelType): boolean {
  return type.kind === "primitive" && type.name === "double";
}

function placed<T extends CelType>(built: T, left: CelType, right: CelType, meeting: Meeting): T {
  return meeting.place(built, left, right);
}

/** The positions a record meets a map's value at: each field, its undeclared members, then each part's entries and undeclared members. */
function recordKeys(record: RecordType): MemberPosition[] {
  const keys: MemberPosition[] = [...record.fields.keys()];
  if (record.additionalFields !== undefined) keys.push(ADDITIONAL_EDGE);
  for (const [part, held] of (record.patternParts ?? []).entries()) {
    for (const at of held.fields.keys()) keys.push(patternEdge(part, at));
    if (held.additionalFields !== undefined) keys.push(partAdditionalEdge(part));
  }
  return keys;
}

/**
 * Two records meet as the union of their fields — which is what composing a shape out of
 * two partial ones means, and what makes a field of each readable and a third an error. A
 * field one side declares meets what stands for it on the other side — the other side's
 * pattern parts' reading of it, else the undeclared members where those are typed; a name
 * either side declares absent, or the other side's matching pattern admits no value for, is
 * absent, and so is one whose meet cannot hold; closed beats open, since a reader of the
 * composition may rely on either half's refusal, and undeclared members that cannot meet
 * close the record. Every field is met, a failing one included.
 *
 * Each side's pattern parts are kept as parts ({@link meetPatternParts}), so every member a
 * pattern matches is read exactly.
 */
function intersectRecords(left: RecordType, right: RecordType, meeting: Meeting): RecordType {
  const absent = new Set([...(left.absentFields ?? []), ...(right.absentFields ?? [])]);
  const declared = [...left.fields.keys(), ...[...right.fields.keys()].filter((name) => !left.fields.has(name))].filter(
    (name) => !absent.has(name),
  );
  // Each field: its first side's type, then what it meets, written-order sides for each.
  const plans: { name: string; start: CelType; meets: readonly CelType[]; reversed: boolean }[] = [];
  for (const name of declared) {
    const held = left.fields.get(name);
    const other = right.fields.get(name);
    const standing = held !== undefined && other !== undefined ? [other] : standingFor(held !== undefined ? right : left, name);
    if (standing === undefined) absent.add(name);
    else plans.push({ name, start: held ?? other!, meets: standing, reversed: held === undefined });
  }
  const both = left.additionalFields !== undefined && right.additionalFields !== undefined;
  const groups = partGroups(left, right, meeting.answers);
  const positions = new Map<EdgeKey, MemberPosition>();
  for (const [part, group] of groups.entries()) {
    for (const [at, entry] of group.entries.entries()) positions.set(patternEdge(part, at), sourcePosition(entry.sources));
    if (group.additional.length > 0) positions.set(partAdditionalEdge(part), sourcePosition(group.additional));
  }
  const keys: MemberPosition[] = plans.map((plan) => plan.name);
  if (both) keys.push(ADDITIONAL_EDGE);
  keys.push(...positions.values());
  meeting.compare(left, right, keys);
  const fields = new Map<string, CelType>();
  const enums = new Map<string, readonly FieldEnumValue[]>();
  for (const plan of plans) {
    const inOrder = plan.reversed ? swapped(meeting) : meeting;
    const met = plan.meets.reduce<CelType | undefined>(
      (held, part) => (held === undefined ? undefined : intersectTypes(held, part, inOrder)),
      plan.start,
    );
    // The meet of two finite sets that holds no value is a field that cannot hold.
    const values = met && metFieldEnum(left.fieldEnums?.get(plan.name), right.fieldEnums?.get(plan.name), met);
    if (!met || values?.length === 0) absent.add(plan.name);
    else {
      fields.set(plan.name, met);
      if (values) enums.set(plan.name, values);
    }
  }
  // Undeclared members that cannot meet close the record.
  const additional = both ? intersectTypes(left.additionalFields!, right.additionalFields!, meeting) : undefined;
  const parts = groups.map((group): PatternPart => {
    const entries = group.entries.map((entry): PatternField => {
      const met = metSources(entry.sources, meeting);
      return met === undefined ? { pattern: entry.pattern } : { pattern: entry.pattern, type: met };
    });
    const undeclared = group.additional.length === 0 ? undefined : metSources(group.additional, meeting);
    return { fields: entries, ...(undeclared === undefined ? {} : { additionalFields: undeclared }) };
  });
  return meeting.place(recordOf(fields, additional, absent, left.name, parts, enums), left, right, positions);
}

/** What one side holds for a member a meeting built from pattern parts: each source of a side that types it. */
function sourcePosition(sources: readonly PartSource[]): MemberPosition {
  const side = (which: 0 | 1): MemberSources =>
    sources.filter((source) => source.which === which && source.type !== undefined).map((source) => [source.edge, source.type!] as const);
  return { sides: [side(0), side(1)] };
}

/** The meet of every source, in written order: nothing where one admits no value or the meet cannot hold. */
function metSources(sources: readonly PartSource[], meeting: Meeting): CelType | undefined {
  if (sources.some((source) => source.type === undefined)) return undefined;
  const ordered = [...sources].sort((left, right) => left.which - right.which);
  return ordered.slice(1).reduce<CelType | undefined>((held, source) => (held === undefined ? undefined : intersectTypes(held, source.type!, meeting)), ordered[0]!.type);
}

/** One side's entry or undeclared members a part met from both sides stands on. */
interface PartSource {
  readonly which: 0 | 1;
  readonly edge: EdgeKey;
  readonly type?: CelType;
}

/** A part of a record two records meet: its entries by text, each with its sources, and the sources of its undeclared members. */
interface PartGroup {
  readonly entries: readonly { readonly pattern: string; readonly sources: readonly PartSource[] }[];
  readonly additional: readonly PartSource[];
}

/**
 * The pattern parts two records' meet carries. A side with one part or none is one part, its
 * undeclared members those of the record where they are a typed schema other than `dyn` (a
 * closed side, or one open to anything, constrains nothing another part's pattern matches); a
 * side met before keeps its parts. Then: a part with neither entries nor undeclared members is
 * dropped; parts with the same pattern texts are one part, their entries met by text and their
 * undeclared members met — unless those cannot meet, when the parts stay apart; parts with no
 * undeclared members are one part; and a part left alone carries none.
 */
function partGroups(left: RecordType, right: RecordType, answers: MeetAnswers): PartGroup[] {
  let groups = [...sideGroups(left, 0), ...sideGroups(right, 1)].filter(
    (group) => group.entries.length > 0 || group.additional.length > 0,
  );
  for (;;) {
    let merged = false;
    for (let at = 0; at < groups.length && !merged; at += 1) {
      for (let other = at + 1; other < groups.length && !merged; other += 1) {
        if (!sameTexts(groups[at]!, groups[other]!) || !undeclaredMeet(groups[at]!, groups[other]!, answers)) continue;
        groups = [...groups.slice(0, at), mergedGroup(groups[at]!, groups[other]!), ...groups.slice(at + 1, other), ...groups.slice(other + 1)];
        merged = true;
      }
    }
    const bare = groups.filter((group) => group.additional.length === 0);
    if (!merged && bare.length > 1) {
      const first = groups.indexOf(bare[0]!);
      const one = bare.reduce(mergedGroup);
      groups = groups.flatMap((group, at) => (at === first ? [one] : bare.includes(group) ? [] : [group]));
      merged = true;
    }
    if (!merged) break;
  }
  if (groups.every((group) => group.entries.length === 0)) return [];
  if (groups.length === 1) return [{ entries: groups[0]!.entries, additional: [] }];
  return groups;
}

function sideGroups(record: RecordType, which: 0 | 1): PartGroup[] {
  const parts = record.patternParts ?? [];
  const entries = (part: PatternPart, at: number) =>
    part.fields.map((entry, index) => ({ pattern: entry.pattern, sources: [{ which, edge: patternEdge(at, index), ...entryType(entry.type) }] }));
  if (parts.length > 1) {
    return parts.map((part, at) => ({
      entries: entries(part, at),
      additional: part.additionalFields === undefined ? [] : [{ which, edge: partAdditionalEdge(at), type: part.additionalFields }],
    }));
  }
  const undeclared = record.additionalFields;
  return [
    {
      entries: parts.length === 0 ? [] : entries(parts[0]!, 0),
      additional: undeclared === undefined || isDyn(undeclared) ? [] : [{ which, edge: ADDITIONAL_EDGE, type: undeclared }],
    },
  ];
}

function entryType(type: CelType | undefined): { type?: CelType } {
  return type === undefined ? {} : { type };
}

/** Whether two parts' undeclared members can meet: trivially where either carries none. */
function undeclaredMeet(left: PartGroup, right: PartGroup, answers: MeetAnswers): boolean {
  if (left.additional.length === 0 || right.additional.length === 0) return true;
  const sources = [...left.additional, ...right.additional];
  if (sources.some((source) => source.type === undefined)) return false;
  const [first, ...rest] = sources.sort((one, other) => one.which - other.which).map((source) => source.type!);
  return rest.reduce<CelType | undefined>((held, next) => (held === undefined ? undefined : intersectTypes(held, next, answers.quiet)), first) !== undefined;
}

function sameTexts(left: PartGroup, right: PartGroup): boolean {
  return (
    left.entries.length === right.entries.length && left.entries.every((entry) => right.entries.some((other) => other.pattern === entry.pattern))
  );
}

/** Two parts as one: the first's entries in order, then the second's it lacks, entries of one text met. */
function mergedGroup(left: PartGroup, right: PartGroup): PartGroup {
  const entries = left.entries.map((entry) => {
    const other = right.entries.find((held) => held.pattern === entry.pattern);
    return other ? { pattern: entry.pattern, sources: [...entry.sources, ...other.sources] } : entry;
  });
  for (const entry of right.entries) if (!left.entries.some((held) => held.pattern === entry.pattern)) entries.push(entry);
  return { entries, additional: [...left.additional, ...right.additional] };
}

/**
 * What stands on a record for a member it does not declare, as types a field meets: its
 * pattern parts' reading of it, or its undeclared members' where those say a type — nothing
 * where the name is absent there.
 */
function standingFor(record: RecordType, name: string): readonly CelType[] | undefined {
  const standing = patternStanding(record, name);
  if (standing !== undefined) {
    if (standing.some((held) => held.type === undefined)) return undefined;
    return standing.map((held) => held.type!).filter((type) => !isDyn(type));
  }
  const additional = record.additionalFields;
  return additional === undefined || isDyn(additional) ? [] : [additional];
}

/**
 * A record against a map's value type: every field, every undeclared member and every
 * pattern part's members a value of it — a field that cannot hold absent, a pattern entry
 * admitting no value, and undeclared members closed.
 */
function intersectRecordWithMap(record: RecordType, value: CelType, meeting: Meeting): RecordType {
  const fields = new Map<string, CelType>();
  const absent = new Set(record.absentFields ?? []);
  const enums = new Map<string, readonly FieldEnumValue[]>();
  for (const [name, type] of record.fields) {
    const met = intersectTypes(type, value, meeting);
    const values = met && metFieldEnum(record.fieldEnums?.get(name), undefined, met);
    if (!met || values?.length === 0) absent.add(name);
    else {
      fields.set(name, met);
      if (values) enums.set(name, values);
    }
  }
  const additional =
    record.additionalFields === undefined ? undefined : intersectTypes(record.additionalFields, value, meeting);
  const parts = (record.patternParts ?? []).map((part): PatternPart => {
    const entries = part.fields.map((entry): PatternField => {
      const met = entry.type === undefined ? undefined : intersectTypes(entry.type, value, meeting);
      return met === undefined ? { pattern: entry.pattern } : { pattern: entry.pattern, type: met };
    });
    const undeclared = part.additionalFields === undefined ? undefined : intersectTypes(part.additionalFields, value, meeting);
    return { fields: entries, ...(undeclared === undefined ? {} : { additionalFields: undeclared }) };
  });
  return recordOf(fields, additional, absent, record.name, parts, enums);
}

/**
 * Two lists meet element by element — a plain list whose element cannot hold holding none —
 * and where either is a tuple, position by position: each side's position, or its rest past
 * its positions, or its element for a plain list — the tuple ending at the first position
 * either side cannot hold. Every position both sides hold is met, one past a failing position
 * included.
 */
function intersectLists(left: ListType, right: ListType, meeting: Meeting): ListType {
  if (!left.prefixElements && !right.prefixElements) {
    meeting.compare(left, right, [ELEMENT_EDGE]);
    const element = intersectTypes(left.element, right.element, meeting);
    return element ? listOf(element) : tupleOf([]);
  }
  const length = Math.max(left.prefixElements?.length ?? 0, right.prefixElements?.length ?? 0);
  const pairs: [CelType, CelType][] = [];
  for (let at = 0; at < length; at += 1) {
    const held = positionOf(left, at);
    const other = positionOf(right, at);
    if (held === undefined || other === undefined) break;
    pairs.push([held, other]);
  }
  const ended = pairs.length < length;
  const rests = ended ? undefined : ([restOf(left), restOf(right)] as const);
  const rest = rests && rests[0] !== undefined && rests[1] !== undefined ? (rests as readonly [CelType, CelType]) : undefined;
  const keys: EdgeKey[] = pairs.map((_, at) => String(at));
  if (rest) keys.push(ADDITIONAL_EDGE);
  meeting.compare(left, right, keys);
  const met = pairs.map(([held, other]) => intersectTypes(held, other, meeting));
  const restMet = rest ? intersectTypes(rest[0], rest[1], meeting) : undefined;
  // A position neither side can hold ends the tuple there.
  const failedAt = met.indexOf(undefined);
  const prefix = (failedAt < 0 ? met : met.slice(0, failedAt)) as CelType[];
  return tupleOf(prefix, failedAt < 0 && !ended ? restMet : undefined);
}

/** The type a list holds at a position: a tuple's position or rest, a plain list's element. */
function positionOf(list: ListType, at: number): CelType | undefined {
  if (!list.prefixElements) return list.element;
  return at < list.prefixElements.length ? list.prefixElements[at] : list.additionalElements;
}

function restOf(list: ListType): CelType | undefined {
  return list.prefixElements ? list.additionalElements : list.element;
}

/**
 * The members a container holds at a position a meeting names, each with the edge it is read
 * through: a declared field; else its pattern parts' reading of it — none where a matching
 * entry admits no value — else the undeclared members standing for it — none where it is
 * declared absent or the record is closed; for a pattern part's edge, the entry or undeclared
 * members it keys; a map's value, a plain list's element, a tuple's position or its rest past
 * them.
 */
function membersAt(side: CelType, position: EdgeKey): (readonly [EdgeKey, CelType])[] {
  switch (side.kind) {
    case "record": {
      if (typeof position === "string") {
        const field = side.fields.get(position);
        if (field !== undefined) return [[position, field]];
        if (side.absentFields?.has(position)) return [];
        const standing = patternStanding(side, position);
        if (standing !== undefined) {
          return standing.some((held) => held.type === undefined) ? [] : standing.map((held) => [held.edge, held.type!] as const);
        }
      } else if (position !== ADDITIONAL_EDGE) {
        for (const [part, held] of (side.patternParts ?? []).entries()) {
          if (position === partAdditionalEdge(part)) return held.additionalFields === undefined ? [] : [[position, held.additionalFields]];
          for (const [at, entry] of held.fields.entries()) {
            if (position === patternEdge(part, at)) return entry.type === undefined ? [] : [[position, entry.type]];
          }
        }
        return [];
      }
      return side.additionalFields === undefined ? [] : [[ADDITIONAL_EDGE, side.additionalFields]];
    }
    case "map":
      return [[ELEMENT_EDGE, side.value]];
    case "list": {
      if (!side.prefixElements) return [[ELEMENT_EDGE, side.element]];
      const at = typeof position === "string" ? Number(position) : side.prefixElements.length;
      if (at < side.prefixElements.length) return [[position, side.prefixElements[at]!]];
      return side.additionalElements === undefined ? [] : [[ADDITIONAL_EDGE, side.additionalElements]];
    }
    default:
      return [];
  }
}

/** Whether a subschema is an object, the only form a keyword can be read from. */
function isSchemaObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a subschema holds nothing but annotations, so every value satisfies it. */
function admitsEveryValue(node: JsonSchemaNode): boolean {
  return Object.keys(node).every((keyword) => ANNOTATION_KEYWORDS.has(keyword));
}

/**
 * Whether every value of a type satisfies a `not` subschema holding only `type`, `const`
 * and `enum` among the type keywords: its `type` covers the member and, where it lists
 * values, it lists every value the member has; with no list, no value keyword narrows it.
 */
function acceptsWholly(negation: JsonSchemaNode, member: CelType): boolean {
  if (negation.type !== undefined && !typeCovers(negation.type, member)) return false;
  const lists = [
    ...("const" in negation ? [[negation.const]] : []),
    ...(Array.isArray(negation.enum) ? [negation.enum] : []),
  ];
  if (lists.length > 0) return lists.every((values) => listsEveryValue(values, member));
  if (negation.type === undefined) return false;
  return Object.keys(negation).every((keyword) => keyword === "type" || ANNOTATION_KEYWORDS.has(keyword));
}

/** Whether a `type` keyword names a JSON type every value of the member is of. */
function typeCovers(type: unknown, member: CelType): boolean {
  const names = Array.isArray(type) ? type : [type];
  const covering: readonly string[] =
    member.kind === "primitive"
      ? ({ null: ["null"], bool: ["boolean"], string: ["string"], int: ["integer", "number"], uint: ["integer", "number"], double: ["number"] } as Record<string, string[]>)[member.name] ?? []
      : member.kind === "record" || member.kind === "map"
        ? ["object"]
        : member.kind === "list"
          ? ["array"]
          : [];
  return names.some((name) => typeof name === "string" && covering.includes(name));
}

/** Whether a list of values holds every value of the member: only a null or a bool has so few. */
function listsEveryValue(values: readonly unknown[], member: CelType): boolean {
  if (member.kind !== "primitive") return false;
  if (member.name === "null") return values.includes(null);
  if (member.name === "bool") return values.includes(true) && values.includes(false);
  return false;
}

/** A JSON Pointer segment, escaped as RFC 6901 writes it. */
function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The node a JSON Pointer names within a document, or nothing where it names none. */
export function nodeAtPointer(root: JsonSchemaNode, pointer: string): JsonSchemaNode | undefined {
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
  return recordOf(read);
}
