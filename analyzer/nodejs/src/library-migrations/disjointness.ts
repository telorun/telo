/**
 * The proof that a migration rule's `match:` is DISJOINT from the current
 * spelling of the type it rewrites — what makes a migration idempotent without a
 * version stamp: a node already in the current spelling can never be matched.
 *
 * The proof reads the schema validation applies, and reads it as at least as
 * permissive as it is, so it refuses a rule only where that reading accepts a
 * matched value:
 *
 * - a local or named `$ref` is followed;
 * - a `oneOf` / `anyOf` refuses only what every branch refuses, an `allOf` what
 *   any one part refuses;
 * - an object refuses an extra key only where it declares
 *   `additionalProperties: false` and no `patternProperties`; at a kind's root
 *   the injected `kind` and `metadata` are never extra;
 * - `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`
 *   and `items` are judged; every other keyword (`not`, `if` / `then`,
 *   `pattern`, `format`, `patternProperties`, dependencies, bounds) is read as
 *   accepting everything;
 * - a reference slot accepts any `!ref` or declaration.
 *
 * Browser-safe: no Node built-ins.
 */
import type { NamedShapeLookup } from "../eval-paths.js";
import { isRefSlot } from "../ref-slot.js";
import { resolveSchemaReference } from "../schema-reference.js";
import {
  isMigrationMap,
  matchTypes,
  migrationMatchHolds,
  migrationValuesEqual,
  pinsValues,
  type MigrationMatch,
} from "./match.js";

type Schema = Record<string, any>;

/** What the proof judges against one schema node: a match, or one concrete
 *  value (a value a match pins, or a member of one). */
type Shape = { readonly match: MigrationMatch } | { readonly value: unknown };

type ValueClass = "null" | "boolean" | "string" | "integer" | "fraction" | "object" | "array";

const ALL_CLASSES: readonly ValueClass[] = ["null", "boolean", "string", "integer", "fraction", "object", "array"];

const UNJUDGED_KEYWORDS: readonly string[] = [
  "not",
  "if",
  "then",
  "else",
  "pattern",
  "format",
  "patternProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minProperties",
  "maxProperties",
];

/** Why a reading the proof makes accepts a matched value at one place. */
export type OverlapNote =
  | { readonly kind: "open"; readonly key: string; readonly pointer: string }
  | { readonly kind: "declared"; readonly key: string; readonly pointer: string }
  | { readonly kind: "unjudged"; readonly keyword: string; readonly pointer: string }
  | { readonly kind: "reference-slot"; readonly pointer: string };

/** The branch of the current schema a match was not proved disjoint from. */
export interface OverlappingBranch {
  /** `oneOf` / `anyOf` and the branch's index, or undefined for a schema that
   *  is no union at its root. */
  readonly union?: { readonly keyword: "oneOf" | "anyOf"; readonly index: number };
  /** The value the branch pins at a member (`type: { const: link }`), if any. */
  readonly tag?: { readonly key: string; readonly value: string };
  readonly title?: string;
  /** The keys the branch requires. */
  readonly required: readonly string[];
  /** The keys the branch declares, when it refuses every other key. */
  readonly closedKeys?: ReadonlySet<string>;
}

/** A match the proof could not separate from the current schema. */
export interface MatchOverlap {
  readonly branch: OverlappingBranch;
  readonly notes: readonly OverlapNote[];
}

export interface DisjointnessOptions {
  /** Resolves a named shape's id to its schema. */
  readonly lookup: NamedShapeLookup;
  /** Keys every value at the schema's root may hold beside what it declares —
   *  a kind's injected `kind` and `metadata`. */
  readonly injectedRootKeys?: ReadonlySet<string>;
}

interface Verdict {
  readonly refused: boolean;
  readonly notes: readonly OverlapNote[];
}

const REFUSED: Verdict = { refused: true, notes: [] };
const ACCEPTED: Verdict = { refused: false, notes: [] };

function isSchema(node: unknown): node is Schema {
  return node !== null && typeof node === "object" && !Array.isArray(node);
}

function classOf(value: unknown): ValueClass | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "fraction";
  if (Array.isArray(value)) return "array";
  if (isMigrationMap(value)) return "object";
  return undefined;
}

function classesOfType(type: unknown): Set<ValueClass> | undefined {
  if (type === undefined) return undefined;
  const names = Array.isArray(type) ? type : [type];
  const classes = new Set<ValueClass>();
  for (const name of names) {
    if (name === "number") {
      classes.add("integer");
      classes.add("fraction");
    } else if (name === "integer") classes.add("integer");
    else if (ALL_CLASSES.includes(name as ValueClass)) classes.add(name as ValueClass);
  }
  return classes;
}

function present(map: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key) && map[key] !== undefined;
}

/** The values a shape can only be, when it pins them. */
function pinnedValues(shape: Shape): unknown[] | undefined {
  if ("value" in shape) return [shape.value];
  const match = shape.match;
  if (!pinsValues(match)) return undefined;
  const candidates = Object.prototype.hasOwnProperty.call(match, "const") ? [match.const] : [...(match.enum ?? [])];
  return candidates.filter((value) => migrationMatchHolds(match, value));
}

function shapeClasses(shape: Shape): Set<ValueClass> {
  if ("value" in shape) {
    const cls = classOf(shape.value);
    return new Set(cls ? [cls] : []);
  }
  return classesOfType(matchTypes(shape.match)) ?? new Set(ALL_CLASSES);
}

function shapeHolds(shape: Shape, value: unknown): boolean {
  return "value" in shape ? migrationValuesEqual(shape.value, value) : migrationMatchHolds(shape.match, value);
}

function requiredKeys(shape: Shape): readonly string[] {
  if ("value" in shape) return isMigrationMap(shape.value) ? Object.keys(shape.value).filter((k) => present(shape.value as Record<string, unknown>, k)) : [];
  return shape.match.required ?? [];
}

function isAbsent(shape: Shape, key: string): boolean {
  if ("value" in shape) return isMigrationMap(shape.value) && !present(shape.value, key);
  return shape.match.properties?.[key] === false;
}

/** The member shape at `key`, or undefined when the shape says nothing of it. */
function memberShape(shape: Shape, key: string): Shape | undefined {
  if ("value" in shape) return isMigrationMap(shape.value) && present(shape.value, key) ? { value: shape.value[key] } : undefined;
  const member = shape.match.properties?.[key];
  return member === undefined || member === false ? undefined : { match: member };
}

function childPointer(pointer: string, key: string): string {
  return `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

interface Place {
  readonly pointer: string;
  readonly root: boolean;
}

class Proof {
  private readonly open = new Map<object, Set<unknown>>();

  constructor(private readonly options: DisjointnessOptions) {}

  refuses(node: unknown, document: Schema | undefined, shape: Shape, at: Place): Verdict {
    if (node === false) return REFUSED;
    if (!isSchema(node)) return ACCEPTED;
    if (isRefSlot(node)) return { refused: false, notes: [{ kind: "reference-slot", pointer: at.pointer || "/" }] };

    const values = "match" in shape ? pinnedValues(shape) : undefined;
    if (values !== undefined) {
      // A pinned match is the values it pins: each one must be refused.
      for (const value of values) {
        const verdict = this.refuses(node, document, { value }, at);
        if (!verdict.refused) return verdict;
      }
      return REFUSED;
    }

    let shapes = this.open.get(node);
    if (!shapes) this.open.set(node, (shapes = new Set()));
    const key = "match" in shape ? shape.match : shape.value;
    if (shapes.has(key)) return ACCEPTED;
    shapes.add(key);
    try {
      return this.refusesNode(node, document, shape, at);
    } finally {
      shapes.delete(key);
    }
  }

  private refusesNode(node: Schema, document: Schema | undefined, shape: Shape, at: Place): Verdict {
    const notes: OverlapNote[] = [];
    if (typeof node.$ref === "string") {
      const target = resolveSchemaReference(node.$ref, document ?? node, this.options.lookup);
      if (target) {
        const verdict = this.refuses(target.node, target.document, shape, at);
        if (verdict.refused) return REFUSED;
        notes.push(...verdict.notes);
      }
    }
    if (Array.isArray(node.allOf)) {
      for (const part of node.allOf) {
        const verdict = this.refuses(part, document, shape, at);
        if (verdict.refused) return REFUSED;
        notes.push(...verdict.notes);
      }
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches) || branches.length === 0) continue;
      const accepting = branches.map((branch) => this.refuses(branch, document, shape, at)).find((v) => !v.refused);
      if (!accepting) return REFUSED;
      notes.push(...accepting.notes);
    }
    const own = this.ownRefuses(node, document, shape, at);
    if (own.refused) return REFUSED;
    notes.push(...own.notes);
    for (const keyword of UNJUDGED_KEYWORDS) {
      if (node[keyword] !== undefined) notes.push({ kind: "unjudged", keyword, pointer: at.pointer || "/" });
    }
    return { refused: false, notes };
  }

  private ownRefuses(node: Schema, document: Schema | undefined, shape: Shape, at: Place): Verdict {
    const allowed = classesOfType(node.type);
    const classes = [...shapeClasses(shape)].filter((cls) => !allowed || allowed.has(cls));
    if (classes.length === 0) return REFUSED;

    const pinned = Object.prototype.hasOwnProperty.call(node, "const")
      ? [node.const]
      : Array.isArray(node.enum)
        ? (node.enum as unknown[])
        : undefined;
    if (pinned && !pinned.some((value) => classes.includes(classOf(value)!) && shapeHolds(shape, value))) {
      return REFUSED;
    }

    const notes: OverlapNote[] = [];
    for (const cls of classes) {
      if (cls === "object") {
        const verdict = this.objectRefuses(node, document, shape, at);
        if (!verdict.refused) return { refused: false, notes: [...notes, ...verdict.notes] };
      } else if (cls === "array") {
        const verdict = this.arrayRefuses(node, document, shape, at);
        if (!verdict.refused) return { refused: false, notes: [...notes, ...verdict.notes] };
      } else {
        return ACCEPTED;
      }
    }
    return REFUSED;
  }

  /** What the node says of a key it may hold: refused, accepted unread, or the
   *  schema it is read against. */
  private memberSchema(
    node: Schema,
    key: string,
    at: Place,
  ): "refused" | "accepted" | "open" | { readonly node: unknown } {
    if (isSchema(node.properties) && Object.prototype.hasOwnProperty.call(node.properties, key)) {
      return { node: node.properties[key] };
    }
    if (at.root && this.options.injectedRootKeys?.has(key)) return "accepted";
    if (isSchema(node.patternProperties) && Object.keys(node.patternProperties).length > 0) return "accepted";
    const extra = node.additionalProperties;
    if (extra === false) return "refused";
    if (isSchema(extra)) return { node: extra };
    return "open";
  }

  private objectRefuses(node: Schema, document: Schema | undefined, shape: Shape, at: Place): Verdict {
    const notes: OverlapNote[] = [];
    const required = requiredKeys(shape);
    for (const key of required) {
      if (isAbsent(shape, key)) return REFUSED;
      const member = this.memberSchema(node, key, at);
      if (member === "refused") return REFUSED;
      if (member === "open") {
        notes.push({ kind: "open", key, pointer: at.pointer });
        continue;
      }
      if (member === "accepted") continue;
      const inner = memberShape(shape, key) ?? { match: {} };
      const verdict = this.refuses(member.node, document, inner, { pointer: childPointer(at.pointer, key), root: false });
      if (verdict.refused) return REFUSED;
      notes.push({ kind: "declared", key, pointer: at.pointer }, ...verdict.notes);
    }
    const declaredRequired = Array.isArray(node.required) ? (node.required as unknown[]) : [];
    for (const key of declaredRequired) {
      if (typeof key !== "string" || required.includes(key)) continue;
      if (isAbsent(shape, key)) return REFUSED;
      const inner = memberShape(shape, key);
      if (!inner) continue;
      const member = this.memberSchema(node, key, at);
      if (member === "refused") return REFUSED;
      if (typeof member !== "object") continue;
      const verdict = this.refuses(member.node, document, inner, { pointer: childPointer(at.pointer, key), root: false });
      if (verdict.refused) return REFUSED;
      notes.push(...verdict.notes);
    }
    return { refused: false, notes };
  }

  private arrayRefuses(node: Schema, document: Schema | undefined, shape: Shape, at: Place): Verdict {
    if (!("value" in shape) || !Array.isArray(shape.value) || !isSchema(node.items)) return ACCEPTED;
    const notes: OverlapNote[] = [];
    for (const [index, item] of shape.value.entries()) {
      const verdict = this.refuses(node.items, document, { value: item }, { pointer: `${at.pointer}/${index}`, root: false });
      if (verdict.refused) return REFUSED;
      notes.push(...verdict.notes);
    }
    return { refused: false, notes };
  }
}

/** `node` with every `$ref` it is followed, and the document it lies in. */
function followed(node: Schema, document: Schema, lookup: NamedShapeLookup): { node: Schema; document: Schema } {
  const seen = new Set<object>();
  let at = { node, document };
  while (typeof at.node.$ref === "string" && !seen.has(at.node)) {
    seen.add(at.node);
    const next = resolveSchemaReference(at.node.$ref, at.document, lookup);
    if (!next || !isSchema(next.node)) break;
    at = { node: next.node, document: next.document };
  }
  return at;
}

function describeBranch(
  node: Schema,
  document: Schema,
  lookup: NamedShapeLookup,
  union: OverlappingBranch["union"],
): OverlappingBranch {
  const branch = followed(node, document, lookup).node;
  const properties = isSchema(branch.properties) ? branch.properties : {};
  let tag: OverlappingBranch["tag"];
  for (const [key, member] of Object.entries(properties)) {
    if (!isSchema(member)) continue;
    const pinned = typeof member.const === "string"
      ? member.const
      : Array.isArray(member.enum) && member.enum.length === 1 && typeof member.enum[0] === "string"
        ? member.enum[0]
        : undefined;
    if (pinned !== undefined) {
      tag = { key, value: pinned };
      break;
    }
  }
  const closed = branch.additionalProperties === false && !(isSchema(branch.patternProperties) && Object.keys(branch.patternProperties).length > 0);
  return {
    ...(union ? { union } : {}),
    ...(tag ? { tag } : {}),
    ...(typeof branch.title === "string" ? { title: branch.title } : {}),
    required: Array.isArray(branch.required) ? branch.required.filter((k: unknown): k is string => typeof k === "string") : [],
    ...(closed ? { closedKeys: new Set(Object.keys(properties)) } : {}),
  };
}

/**
 * Undefined when `match` is proved disjoint from `schema`, the current schema of
 * the type a rule rewrites; otherwise the branch the proof could not separate it
 * from — the first branch of the schema's root union that accepts a matched
 * value, or the whole schema — and why that branch's reading accepts one.
 */
export function matchOverlap(
  schema: Schema,
  match: MigrationMatch,
  options: DisjointnessOptions,
): MatchOverlap | undefined {
  const proof = new Proof(options);
  const at: Place = { pointer: "", root: true };
  const verdict = proof.refuses(schema, schema, { match }, at);
  if (verdict.refused) return undefined;
  const root = followed(schema, schema, options.lookup);
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = root.node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) {
      const branchVerdict = new Proof(options).refuses(branch, root.document, { match }, at);
      if (branchVerdict.refused) continue;
      return {
        branch: describeBranch(branch, root.document, options.lookup, { keyword, index }),
        notes: dedupeNotes(branchVerdict.notes),
      };
    }
  }
  return { branch: describeBranch(root.node, root.document, options.lookup, undefined), notes: dedupeNotes(verdict.notes) };
}

function dedupeNotes(notes: readonly OverlapNote[]): OverlapNote[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = JSON.stringify(note);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every schema node `segments` reach from `node`, through references, unions,
 *  `allOf`, `properties`, `additionalProperties` and `items`. */
export function schemaNodesAt(
  node: unknown,
  document: Schema,
  segments: readonly string[],
  lookup: NamedShapeLookup,
): Schema[] {
  const found: Schema[] = [];
  const visit = (current: unknown, doc: Schema, depth: number, guard: Set<object>): void => {
    if (!isSchema(current) || guard.has(current)) return;
    const nextGuard = new Set(guard).add(current);
    if (depth === segments.length && !found.includes(current)) found.push(current);
    if (typeof current.$ref === "string") {
      const target = resolveSchemaReference(current.$ref, doc, lookup);
      if (target) visit(target.node, target.document, depth, nextGuard);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      if (Array.isArray(current[keyword])) for (const part of current[keyword]) visit(part, doc, depth, nextGuard);
    }
    if (depth === segments.length) return;
    const segment = segments[depth]!;
    if (isSchema(current.properties) && Object.prototype.hasOwnProperty.call(current.properties, segment)) {
      visit(current.properties[segment], doc, depth + 1, new Set());
    } else if (isSchema(current.additionalProperties)) {
      visit(current.additionalProperties, doc, depth + 1, new Set());
    }
    if (/^\d+$/.test(segment) && isSchema(current.items)) visit(current.items, doc, depth + 1, new Set());
  };
  visit(node, document, 0, new Set());
  return found;
}
