/**
 * CEL's types.
 *
 * The domain is deliberately richer than the one an expression can spell, because
 * the checker's whole value is in what it can be *told*: a variable typed from a
 * JSON Schema carries its nested objects, its element types and its unions, and a
 * typo two levels down is then a type error rather than something only a running
 * request discovers.
 *
 * Four shapes exist for that reason and have no syntax of their own:
 *
 * - `record` — an object with named fields, each typed in turn; `additionalFields` types
 *   every member it does not declare (absent: closed, a member it does not declare is
 *   undeclared), `absentFields` names the members declared to hold no value,
 *   `patternParts` types every member whose name a pattern matches, one schema part at a time,
 *   and `fieldEnums` holds, per declared field, the finite set of values its schema admits.
 * - `union` — carried as a union rather than collapsed to `dyn`, so `int|null` keeps
 *   both the arithmetic and the null that makes a dereference worth reporting.
 * - `nominal` — a named type over a base, with invariant arguments: the mechanism a
 *   host registers its own vocabulary through. **A nominal is not its base**: it
 *   accepts only what is registered for it, which is what makes a slot expecting one
 *   refuse a plain value of the base. (The vectors pin this: an operator the base
 *   accepts is refused on the named type.)
 * - `parameter` — a type variable in a signature, unified per call and invariant.
 *
 * `dyn` is the top: it is assignable both ways, which is what keeps an unlisted
 * variable or an unknown call result from cascading into a second error.
 */

import { re2Pattern } from "./regular-expression.js";
import { countTypeVisit } from "./type-visits.js";
import typeText from "./type-text.json" with { type: "json" };

export type PrimitiveName =
  | "int"
  | "uint"
  | "double"
  | "bool"
  | "string"
  | "bytes"
  | "null"
  | "type"
  | "timestamp"
  | "duration";

export interface DynType {
  readonly kind: "dyn";
}
export interface PrimitiveType {
  readonly kind: "primitive";
  readonly name: PrimitiveName;
}
export interface ListType {
  readonly kind: "list";
  /** The type of every element: for a tuple, the join of every position and the rest. */
  readonly element: CelType;
  /** A tuple's leading positions, each typed in turn; absent on a plain list. */
  readonly prefixElements?: readonly CelType[];
  /**
   * The type of every element past `prefixElements`; absent means no element follows them.
   * Carried only beside `prefixElements`, which {@link tupleOf} alone builds.
   */
  readonly additionalElements?: CelType;
}
export interface MapType {
  readonly kind: "map";
  readonly key: CelType;
  readonly value: CelType;
}
export interface OptionalType {
  readonly kind: "optional";
  readonly value: CelType;
}
export interface RecordType {
  readonly kind: "record";
  readonly name?: string;
  readonly fields: ReadonlyMap<string, CelType>;
  /** The type of every member the record does not declare; absent, the record is closed. */
  readonly additionalFields?: CelType;
  /**
   * The member names whose schema admits no value: read as no member, never typed by
   * `additionalFields`. Never names a declared field; absent rather than empty.
   */
  readonly absentFields?: ReadonlySet<string>;
  /**
   * `patternProperties`, one part per schema part declaring them: a member no field declares
   * that some part's pattern (RE2) matches is the meet over the parts of each part's matching
   * entries, else that part's `additionalFields`. A declared field is already met with them.
   * Absent rather than empty.
   */
  readonly patternParts?: readonly PatternPart[];
  /**
   * Per declared field whose schema admits a finite set of values, that set, each value as
   * the field's type reads it, in canonical order ({@link compareFieldEnumValues}). Never
   * names an undeclared field, never holds an empty set; absent rather than empty.
   */
  readonly fieldEnums?: ReadonlyMap<string, readonly FieldEnumValue[]>;
}
/** A value a field's finite set holds: a string, an int, a double, a bool or null. */
export type FieldEnumValue = string | bigint | number | boolean | null;
/** One `patternProperties` entry: its pattern, and the type it gives — absent: no value. */
export interface PatternField {
  readonly pattern: string;
  readonly type?: CelType;
}
/**
 * The patterns one schema part declares, in written order, and the type it gives a member
 * another part's pattern matches and none of its own does — absent where the part is closed
 * or open to anything.
 */
export interface PatternPart {
  readonly fields: readonly PatternField[];
  readonly additionalFields?: CelType;
}
export interface UnionType {
  readonly kind: "union";
  readonly members: readonly CelType[];
}
export interface NominalType {
  readonly kind: "nominal";
  readonly name: string;
  readonly base: CelType;
  readonly args: readonly CelType[];
  /**
   * The fields a value of the type carries, where its definition declares any — read by
   * `.`, `.?` and `has()`. Absent means the type holds no members at all. Carried on the
   * type rather than looked up by name, so every reader holding the type knows its fields.
   */
  readonly fields?: ReadonlyMap<string, CelType>;
}
export interface ParameterType {
  readonly kind: "parameter";
  readonly name: string;
}

export type CelType =
  | DynType
  | PrimitiveType
  | ListType
  | MapType
  | OptionalType
  | RecordType
  | UnionType
  | NominalType
  | ParameterType;

export const DYN: DynType = { kind: "dyn" };

const primitive = (name: PrimitiveName): PrimitiveType => ({ kind: "primitive", name });

export const INT = primitive("int");
export const UINT = primitive("uint");
export const DOUBLE = primitive("double");
export const BOOL = primitive("bool");
export const STRING = primitive("string");
export const BYTES = primitive("bytes");
export const NULL = primitive("null");
export const TYPE = primitive("type");
export const TIMESTAMP = primitive("timestamp");
export const DURATION = primitive("duration");

export const listOf = (element: CelType): ListType => ({ kind: "list", element });

/**
 * The one tuple constructor: its positions, the type of every element past them (absent:
 * none), and the element type their join is.
 */
export function tupleOf(prefixElements: readonly CelType[], additionalElements?: CelType): ListType {
  const parts = additionalElements === undefined ? prefixElements : [...prefixElements, additionalElements];
  return {
    kind: "list",
    element: unionOf(parts),
    prefixElements,
    ...(additionalElements === undefined ? {} : { additionalElements }),
  };
}

/**
 * The one record constructor: `absentFields`, `patternParts` and `fieldEnums` are dropped
 * when empty, each set is put in canonical order with its duplicates dropped, and naming a
 * declared field absent, one pattern twice within a part, a set for an undeclared field or
 * an empty set is an engine defect.
 */
export function recordOf(
  fields: ReadonlyMap<string, CelType>,
  additionalFields?: CelType,
  absentFields?: ReadonlySet<string>,
  name?: string,
  patternParts?: readonly PatternPart[],
  fieldEnums?: ReadonlyMap<string, readonly FieldEnumValue[]>,
): RecordType {
  if (absentFields) {
    for (const absent of absentFields) {
      if (fields.has(absent)) throw new Error(`record type: "${absent}" is declared and absent`);
    }
  }
  for (const part of patternParts ?? []) {
    if (new Set(part.fields.map((entry) => entry.pattern)).size !== part.fields.length) {
      throw new Error("record type: a pattern is written twice in one part");
    }
  }
  let enums: Map<string, readonly FieldEnumValue[]> | undefined;
  for (const [field, values] of fieldEnums ?? []) {
    if (!fields.has(field)) throw new Error(`record type: "${field}" has a set of values and is not declared`);
    if (values.length === 0) throw new Error(`record type: "${field}" has an empty set of values`);
    (enums ??= new Map()).set(field, canonicalFieldEnum(values));
  }
  return {
    kind: "record",
    fields,
    ...(name === undefined ? {} : { name }),
    ...(additionalFields === undefined ? {} : { additionalFields }),
    ...(absentFields === undefined || absentFields.size === 0 ? {} : { absentFields }),
    ...(patternParts === undefined || patternParts.length === 0 ? {} : { patternParts }),
    ...(enums === undefined ? {} : { fieldEnums: enums }),
  };
}

const ENUM_VALUE_RANK = { null: 0, boolean: 1, bigint: 2, number: 3, string: 4 } as const;

function enumValueRank(value: FieldEnumValue): number {
  return value === null ? 0 : ENUM_VALUE_RANK[typeof value as "boolean" | "bigint" | "number" | "string"];
}

/**
 * The canonical order of a field's set: null, then bools, ints, doubles and strings, each by
 * value — a string by code point, so every engine orders it alike.
 */
export function compareFieldEnumValues(left: FieldEnumValue, right: FieldEnumValue): number {
  const rank = enumValueRank(left) - enumValueRank(right);
  if (rank !== 0 || left === null) return rank;
  if (typeof left === "string") return compareCodePoints(left, right as string);
  const [a, b] = [left as number | bigint | boolean, right as number | bigint | boolean];
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    const difference = a[at]!.codePointAt(0)! - b[at]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** A set's values in canonical order, each once, a double's negative zero read as zero. */
function canonicalFieldEnum(values: readonly FieldEnumValue[]): readonly FieldEnumValue[] {
  const sorted = values.map((value) => (value === 0 && typeof value === "number" ? 0 : value)).sort(compareFieldEnumValues);
  return sorted.filter((value, at) => at === 0 || compareFieldEnumValues(sorted[at - 1]!, value) !== 0);
}

/**
 * Per part, the positions of its entries matching a member name, in written order — RE2
 * search, as `matches` reads a pattern; nothing where no part's pattern matches. A record
 * carries only patterns RE2 reads.
 */
export function partMatches(record: RecordType, member: string): (readonly number[])[] | undefined {
  const parts = record.patternParts;
  if (parts === undefined) return undefined;
  let any = false;
  const matched = parts.map((part) => {
    const at: number[] = [];
    for (let index = 0; index < part.fields.length; index += 1) {
      const held = re2Pattern(part.fields[index]!.pattern);
      if ("pattern" in held && held.pattern.matcher(member).find()) at.push(index);
    }
    if (at.length > 0) any = true;
    return at;
  });
  return any ? matched : undefined;
}

/** Every pattern a record carries, each text once, in written order. */
export function recordPatterns(record: RecordType): string[] {
  const patterns: string[] = [];
  for (const part of record.patternParts ?? []) {
    for (const entry of part.fields) if (!patterns.includes(entry.pattern)) patterns.push(entry.pattern);
  }
  return patterns;
}

export const mapOf = (key: CelType, value: CelType): MapType => ({ kind: "map", key, value });
export const optionalOf = (value: CelType): OptionalType => ({ kind: "optional", value });
export const parameterOf = (name: string): ParameterType => ({ kind: "parameter", name });

/** A union of its distinct members; one member is that member, none is `dyn`. */
export function unionOf(members: readonly CelType[]): CelType {
  const flat: CelType[] = [];
  for (const member of members) {
    for (const part of member.kind === "union" ? member.members : [member]) {
      if (!flat.some((held) => typesEqual(held, part))) flat.push(part);
    }
  }
  if (flat.length === 0) return DYN;
  if (flat.length === 1) return flat[0]!;
  if (flat.some((member) => member.kind === "dyn")) return DYN;
  return { kind: "union", members: flat };
}

/** The names the timestamp and duration types are written and printed under. */
export const WELL_KNOWN_TYPE_NAMES: Readonly<Record<string, PrimitiveName>> = {
  "google.protobuf.Timestamp": "timestamp",
  "google.protobuf.Duration": "duration",
};

const PRIMITIVE_PRINTED: Readonly<Record<PrimitiveName, string>> = {
  int: "int",
  uint: "uint",
  double: "double",
  bool: "bool",
  string: "string",
  bytes: "bytes",
  null: "null",
  type: "type",
  timestamp: "google.protobuf.Timestamp",
  duration: "google.protobuf.Duration",
};

export function isDyn(type: CelType): boolean {
  return type.kind === "dyn";
}

export function typesEqual(left: CelType, right: CelType): boolean {
  countTypeVisit();
  return equalWithoutWalk(left, right) ?? new TypePairs().equalContainers(left, right);
}

/** Whether two types are one, where that needs no walk beneath them; nothing where both hold types. */
function equalWithoutWalk(left: CelType, right: CelType): boolean | undefined {
  // A type is itself: a shape shared at many places is compared once, not once per path to it.
  if (left === right) return true;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "dyn":
      return true;
    case "primitive":
      return left.name === (right as PrimitiveType).name;
    case "parameter":
      return left.name === (right as ParameterType).name;
    default:
      return undefined;
  }
}

/** The answers of one walk over two types, by the identities of the pair. */
type PairAnswers<T> = Map<CelType, Map<CelType, T>>;

function remember<T>(answers: PairAnswers<T>, left: CelType, right: CelType, answer: T): void {
  let row = answers.get(left);
  if (!row) answers.set(left, (row = new Map()));
  row.set(right, answer);
}

/**
 * One two-type walk — equality, assignability or the join — for the duration of the call:
 * types are shared graphs, so each identity pair beneath the two it began with is answered
 * once, and a type compared with itself at once. Types hold no cycle, so the answers are
 * results, never assumptions; the pair a walk begins with is never met again beneath it.
 */
class TypePairs {
  private equalities?: PairAnswers<boolean>;
  private assignments?: PairAnswers<boolean>;
  private joins?: PairAnswers<CelType>;

  equal(left: CelType, right: CelType): boolean {
    countTypeVisit();
    const quick = equalWithoutWalk(left, right);
    if (quick !== undefined) return quick;
    const held = this.equalities?.get(left)?.get(right);
    if (held !== undefined) return held;
    const answer = this.equalContainers(left, right);
    remember((this.equalities ??= new Map()), left, right, answer);
    return answer;
  }

  /** {@link typesEqual} of two types of one kind that hold types. */
  equalContainers(left: CelType, right: CelType): boolean {
    switch (left.kind) {
      case "list": {
        const other = right as ListType;
        // A tuple's element is derived from its positions and rest, so two tuples compare those alone.
        if (left.prefixElements || other.prefixElements) {
          return (
            this.typeListsEqual(left.prefixElements, other.prefixElements) &&
            this.optionalTypesEqual(left.additionalElements, other.additionalElements)
          );
        }
        return this.equal(left.element, other.element);
      }
      case "map": {
        const other = right as MapType;
        return this.equal(left.key, other.key) && this.equal(left.value, other.value);
      }
      case "optional":
        return this.equal(left.value, (right as OptionalType).value);
      case "record": {
        const other = right as RecordType;
        if (
          left.name !== other.name ||
          left.fields.size !== other.fields.size ||
          !this.optionalTypesEqual(left.additionalFields, other.additionalFields) ||
          !namesEqual(left.absentFields, other.absentFields) ||
          !this.partsEqual(left.patternParts, other.patternParts) ||
          !fieldEnumsEqual(left.fieldEnums, other.fieldEnums)
        ) {
          return false;
        }
        for (const [field, type] of left.fields) {
          const held = other.fields.get(field);
          if (!held || !this.equal(type, held)) return false;
        }
        return true;
      }
      case "union": {
        const other = right as UnionType;
        return (
          left.members.length === other.members.length &&
          left.members.every((member, at) => this.equal(member, other.members[at]!))
        );
      }
      case "nominal": {
        const other = right as NominalType;
        return (
          left.name === other.name &&
          left.args.length === other.args.length &&
          left.args.every((argument, at) => this.equal(argument, other.args[at]!))
        );
      }
      default:
        return equalWithoutWalk(left, right)!;
    }
  }

  private optionalTypesEqual(left: CelType | undefined, right: CelType | undefined): boolean {
    return left === undefined || right === undefined ? left === right : this.equal(left, right);
  }

  private typeListsEqual(left: readonly CelType[] | undefined, right: readonly CelType[] | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    return left.length === right.length && left.every((type, at) => this.equal(type, right[at]!));
  }

  /** The same parts in any order, each giving the same undeclared type and the same patterns in any order. */
  private partsEqual(left: readonly PatternPart[] | undefined, right: readonly PatternPart[] | undefined): boolean {
    if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
    const unmatched = [...(right ?? [])];
    for (const part of left ?? []) {
      const at = unmatched.findIndex((other) => this.partEqual(part, other));
      if (at < 0) return false;
      unmatched.splice(at, 1);
    }
    return true;
  }

  private partEqual(left: PatternPart, right: PatternPart): boolean {
    if (left.fields.length !== right.fields.length || !this.optionalTypesEqual(left.additionalFields, right.additionalFields)) return false;
    for (const entry of left.fields) {
      const held = right.fields.find((other) => other.pattern === entry.pattern);
      if (!held || !this.optionalTypesEqual(entry.type, held.type)) return false;
    }
    return true;
  }

  assignable(from: CelType, to: CelType): boolean {
    countTypeVisit();
    const quick = assignableWithoutWalk(from, to);
    if (quick !== undefined) return quick;
    const held = this.assignments?.get(from)?.get(to);
    if (held !== undefined) return held;
    const answer = this.assignableBeneath(from, to);
    remember((this.assignments ??= new Map()), from, to, answer);
    return answer;
  }

  /** {@link assignable} where it needs a walk beneath the two. */
  assignableBeneath(from: CelType, to: CelType): boolean {
    if (from.kind === "union") return from.members.every((member) => this.assignable(member, to));
    if (to.kind === "union") return to.members.some((member) => this.assignable(from, member));
    if (from.kind === "nominal" || to.kind === "nominal") return this.equal(from, to);
    switch (to.kind) {
      case "list":
        if (from.kind !== "list") return false;
        return from.prefixElements && to.prefixElements ? this.tupleAssignable(from, to) : this.assignable(from.element, to.element);
      case "map":
        return (
          (from.kind === "map" && this.assignable(from.key, to.key) && this.assignable(from.value, to.value)) ||
          // A record is a map with named keys, so it stands where a string-keyed map does.
          (from.kind === "record" && this.assignable(STRING, to.key) && this.recordValuesAssignable(from, to.value))
        );
      case "optional":
        return from.kind === "optional" && this.assignable(from.value, to.value);
      case "record":
        return from.kind === "record" && this.equal(from, to);
      default:
        return this.equal(from, to);
    }
  }

  /**
   * A tuple where a tuple is wanted: element by element, and position by position where both
   * declare one. A position standing where its counterpart does stands where the wanted element
   * does, so each is asked once: the shared positions pairwise, then the rest of `from`'s
   * members against the wanted element — unless `from`'s element is `dyn`, which stands anywhere.
   */
  private tupleAssignable(from: ListType, to: ListType): boolean {
    const [held, wanted] = [from.prefixElements!, to.prefixElements!];
    const shared = Math.min(held.length, wanted.length);
    for (let at = 0; at < shared; at += 1) {
      if (!this.assignable(held[at]!, wanted[at]!)) return false;
    }
    if (isDyn(from.element)) return true;
    for (let at = shared; at < held.length; at += 1) {
      if (!this.assignable(held[at]!, to.element)) return false;
    }
    return from.additionalElements === undefined || this.assignable(from.additionalElements, to.element);
  }

  /** Every field, every pattern's members and every member it does not declare, judged against the map's value type. */
  private recordValuesAssignable(record: RecordType, to: CelType): boolean {
    if (isDyn(to)) return true;
    return recordMemberTypes(record).every((type) => this.assignable(type, to));
  }

  /** {@link unify}; the pair the walk begins with is not kept, since nothing beneath it meets it again. */
  join(left: CelType, right: CelType, first = false): CelType {
    countTypeVisit();
    if (this.equal(left, right)) return left;
    if (left.kind === "parameter") return right;
    if (right.kind === "parameter") return left;
    if (isDyn(left) || isDyn(right)) return DYN;
    const held = first ? undefined : this.joins?.get(left)?.get(right);
    if (held !== undefined) return held;
    const joined = this.joinBeneath(left, right);
    if (!first) remember((this.joins ??= new Map()), left, right, joined);
    return joined;
  }

  private joinBeneath(left: CelType, right: CelType): CelType {
    // Null joins apart: the rest is joined, and null added back where either side admitted it.
    if (admitsNull(left) || admitsNull(right)) {
      const leftHeld = isNull(left) ? undefined : withoutNull(left);
      const rightHeld = isNull(right) ? undefined : withoutNull(right);
      if (leftHeld === undefined || rightHeld === undefined) return unionOf([leftHeld ?? rightHeld ?? NULL, NULL]);
      const joined = this.join(leftHeld, rightHeld);
      return isDyn(joined) ? DYN : unionOf([joined, NULL]);
    }
    // A union joined with a type it includes is that union.
    if (this.includes(left, right)) return left;
    if (this.includes(right, left)) return right;
    if (left.kind === "union" || right.kind === "union") return this.joinByKin(left, right);
    if (left.kind === "list" && right.kind === "list") return this.joinLists(left, right);
    if (left.kind === "map" && right.kind === "map") {
      return mapOf(this.join(left.key, right.key), this.join(left.value, right.value));
    }
    if (left.kind === "optional" && right.kind === "optional") return optionalOf(this.join(left.value, right.value));
    // A record is a map with named keys (see `assignable`), so against a map, or a record of
    // another shape, it joins as that map.
    if (left.kind === "record" && (right.kind === "record" || right.kind === "map")) {
      return this.joinRecordAsMap(left, right);
    }
    if (right.kind === "record" && left.kind === "map") return this.joinRecordAsMap(right, left);
    return DYN;
  }

  /**
   * A union against another type — the left one where both are unions — one member of the other
   * at a time: a member that stands where some member of the union does is absorbed, one whose
   * join with some member of the union is one type is kept as a member of its own, and one with
   * nothing in common with any makes the join `dyn`, "not one type". The members stay in
   * written order, the union's all kept.
   */
  private joinByKin(left: CelType, right: CelType): CelType {
    const union = (left.kind === "union" ? left : right) as UnionType;
    const other = union === left ? right : left;
    const kept: CelType[] = [];
    for (const member of other.kind === "union" ? other.members : [other]) {
      if (union.members.some((held) => this.assignable(member, held))) continue;
      if (!union.members.some((held) => !isDyn(this.join(member, held)))) return DYN;
      kept.push(member);
    }
    return unionOf(union === left ? [...union.members, ...kept] : [...kept, ...union.members]);
  }

  /** Whether a union holds every member of `part` (or `part` itself). */
  private includes(union: CelType, part: CelType): boolean {
    if (union.kind !== "union") return false;
    const parts = part.kind === "union" ? part.members : [part];
    return parts.every((held) => union.members.some((member) => this.equal(member, held)));
  }

  /**
   * Two tuples of as many positions join position by position, their rest the join of the
   * rests they have; anything else joins as the list of the joined elements.
   */
  private joinLists(left: ListType, right: ListType): ListType {
    const prefix = left.prefixElements;
    const other = right.prefixElements;
    if (!prefix || !other || prefix.length !== other.length) return listOf(this.join(left.element, right.element));
    const rests = [left.additionalElements, right.additionalElements].filter((rest): rest is CelType => rest !== undefined);
    const rest = rests.length === 0 ? undefined : rests.reduce((joined, held) => this.join(joined, held));
    return tupleOf(
      prefix.map((type, at) => this.join(type, other[at]!)),
      rest,
    );
  }

  private joinRecordAsMap(record: RecordType, other: RecordType | MapType): MapType {
    const key = other.kind === "map" ? this.join(STRING, other.key) : STRING;
    const values = [this.recordValue(record), other.kind === "map" ? other.value : this.recordValue(other)];
    return mapOf(key, values.reduce((joined, value) => this.join(joined, value)));
  }

  recordValue(record: RecordType): CelType {
    let joined: CelType = parameterOf("V");
    for (const type of recordMemberTypes(record)) joined = this.join(joined, type);
    return joined;
  }
}

/** The same fields carrying a set, each the same set: canonical order makes it a comparison in order. */
function fieldEnumsEqual(
  left: ReadonlyMap<string, readonly FieldEnumValue[]> | undefined,
  right: ReadonlyMap<string, readonly FieldEnumValue[]> | undefined,
): boolean {
  if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
  for (const [field, values] of left ?? []) {
    const held = right!.get(field);
    if (!held || held.length !== values.length) return false;
    if (values.some((value, at) => compareFieldEnumValues(value, held[at]!) !== 0)) return false;
  }
  return true;
}

function namesEqual(left: ReadonlySet<string> | undefined, right: ReadonlySet<string> | undefined): boolean {
  if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
  for (const name of left ?? []) if (!right!.has(name)) return false;
  return true;
}

/**
 * How many type nodes a printed type writes before it is cut: a type a check reports or a
 * message names can hold more than any reader wants, and a shared graph prints as a tree.
 */
export const TYPE_TEXT_NODE_LIMIT: number = typeText.typeTextNodeLimit;

/**
 * How a type is written. `top` collapses a list or map of `dyn` to its bare name,
 * which is how the whole type of an expression is reported.
 *
 * **Written whole up to {@link TYPE_TEXT_NODE_LIMIT} type nodes, then cut.** Printing walks
 * the type in pre-order — a union's members in order, a container's arguments in order, a
 * record as its one name — and each type node written counts one (a union writes only its
 * members). The node that would exceed the limit is written `...` and printing stops there,
 * every open bracket closed, so the text is bounded by the limit whatever the type's size.
 * This is the one writer of a type a check reports and a message names.
 */
export function formatType(type: CelType, top = false): string {
  const writer: TypeWriter = { text: [], written: 0, limit: TYPE_TEXT_NODE_LIMIT, stopped: false };
  writeType(type, top, writer);
  return writer.text.join("");
}

/**
 * A type written whole, however large — the text a signature and the environment's listing
 * are identified by, which a cut would let two different types share. Never shown as a
 * checked type: that is {@link formatType}'s.
 */
export function exactTypeText(type: CelType, top = false): string {
  const writer: TypeWriter = { text: [], written: 0, limit: Infinity, stopped: false };
  writeType(type, top, writer);
  return writer.text.join("");
}

interface TypeWriter {
  readonly text: string[];
  written: number;
  readonly limit: number;
  stopped: boolean;
}

function writeType(type: CelType, top: boolean, writer: TypeWriter): void {
  if (type.kind === "union") {
    for (const [at, member] of type.members.entries()) {
      if (writer.stopped) return;
      if (at > 0) writer.text.push("|");
      writeType(member, false, writer);
    }
    return;
  }
  if (writer.written === writer.limit) {
    writer.text.push("...");
    writer.stopped = true;
    return;
  }
  writer.written += 1;
  const write = (text: string): void => {
    writer.text.push(text);
  };
  const argumentsOf = (args: readonly CelType[]) => {
    for (const [at, argument] of args.entries()) {
      if (writer.stopped) return;
      if (at > 0) write(", ");
      writeType(argument, false, writer);
    }
  };
  switch (type.kind) {
    case "dyn":
      return write("dyn");
    case "primitive":
      return write(PRIMITIVE_PRINTED[type.name]);
    case "list":
      if (top && isDyn(type.element)) return write("list");
      write("list<");
      argumentsOf([type.element]);
      return write(">");
    case "map":
      if (top && isDyn(type.key) && isDyn(type.value)) return write("map");
      write("map<");
      argumentsOf([type.key, type.value]);
      return write(">");
    case "optional":
      write("optional<");
      argumentsOf([type.value]);
      return write(">");
    case "record":
      // An unnamed record is the shape a map has at runtime, and that is how a
      // message names it; its fields are what a diagnostic lists, not its type.
      return write(type.name ?? "map");
    case "nominal":
      write(type.name);
      if (type.args.length === 0) return;
      write("<");
      argumentsOf(type.args);
      return write(">");
    case "parameter":
      return write(type.name);
  }
}

/** The numeric types, over which CEL compares and converts across type. */
const NUMERIC = new Set<PrimitiveName>(["int", "uint", "double"]);

export function isNumeric(type: CelType): boolean {
  return type.kind === "primitive" && NUMERIC.has(type.name);
}

/**
 * The type with every unresolved type parameter replaced by `dyn` — the last step before a
 * type is REPORTED.
 *
 * cel-spec's rule is that an unresolved parameter behaves as `dyn` wherever it is used, and
 * the type handed out is a use like any other: a consumer that reads `list<T>` has to know
 * what `T` means to this engine, and the answer is "nothing — it was never resolved". A
 * parameter survives only where it is DECLARED: a signature's text, a nominal type's
 * parameter list.
 */
export function withoutParameters(type: CelType): CelType {
  return replaceParameters(type, new Map());
}

/** {@link withoutParameters}, each type object answered once per call: a shared part is replaced once and stays shared. */
function replaceParameters(type: CelType, replaced: Map<CelType, CelType>): CelType {
  countTypeVisit();
  if (type.kind === "parameter") return DYN;
  if (type.kind === "dyn" || type.kind === "primitive") return type;
  const held = replaced.get(type);
  if (held !== undefined) return held;
  const answer = replacedOnce(type, replaced);
  replaced.set(type, answer);
  return answer;
}

function replacedOnce(type: CelType, replaced: Map<CelType, CelType>): CelType {
  const beneath = (held: CelType) => replaceParameters(held, replaced);
  switch (type.kind) {
    case "list": {
      if (type.prefixElements) {
        const prefix = type.prefixElements.map(beneath);
        const rest = type.additionalElements === undefined ? undefined : beneath(type.additionalElements);
        const moved = rest !== type.additionalElements || prefix.some((held, at) => held !== type.prefixElements![at]);
        return moved ? tupleOf(prefix, rest) : type;
      }
      const element = beneath(type.element);
      return element === type.element ? type : listOf(element);
    }
    case "map": {
      const key = beneath(type.key);
      const value = beneath(type.value);
      return key === type.key && value === type.value ? type : mapOf(key, value);
    }
    case "optional": {
      const value = beneath(type.value);
      return value === type.value ? type : optionalOf(value);
    }
    case "union":
      return unionOf(type.members.map(beneath));
    case "nominal": {
      const args = type.args.map(beneath);
      return args.every((argument, at) => argument === type.args[at]) ? type : { ...type, args };
    }
    case "record": {
      let moved = false;
      const fields = new Map<string, CelType>();
      for (const [name, held] of type.fields) {
        const replaced = beneath(held);
        if (replaced !== held) moved = true;
        fields.set(name, replaced);
      }
      const additional = type.additionalFields === undefined ? undefined : beneath(type.additionalFields);
      if (additional !== type.additionalFields) moved = true;
      const replace = (held: CelType | undefined) => {
        if (held === undefined) return undefined;
        const replaced = beneath(held);
        if (replaced !== held) moved = true;
        return replaced;
      };
      const parts = type.patternParts?.map((part): PatternPart => {
        const entries = part.fields.map((entry): PatternField => {
          const replaced = replace(entry.type);
          return replaced === entry.type ? entry : { pattern: entry.pattern, type: replaced };
        });
        const additionalFields = replace(part.additionalFields);
        return { fields: entries, ...(additionalFields === undefined ? {} : { additionalFields }) };
      });
      return moved ? recordOf(fields, additional, type.absentFields, type.name, parts, type.fieldEnums) : type;
    }
    default:
      return type;
  }
}

/** Whether `type` admits a null value — a null, or a union holding one. */
export function admitsNull(type: CelType): boolean {
  if (type.kind === "primitive") return type.name === "null";
  if (type.kind === "union") return type.members.some(admitsNull);
  return false;
}

/** The type with every null taken out of it; `dyn` and a bare null are unchanged. */
export function withoutNull(type: CelType): CelType {
  if (type.kind !== "union") return type;
  const members = type.members.filter((member) => !admitsNull(member));
  return members.length === 0 ? type : unionOf(members);
}

/**
 * Whether a value of `from` may stand where `to` is wanted.
 *
 * `dyn` passes both ways; a nominal type accepts only itself (its base is a
 * different type); a union passes where every member does, and accepts a value any
 * member accepts. Numeric types do **not** convert implicitly — CEL's cross-type
 * arithmetic and comparison are declared overloads, not coercions.
 */
export function assignable(from: CelType, to: CelType): boolean {
  countTypeVisit();
  return assignableWithoutWalk(from, to) ?? new TypePairs().assignableBeneath(from, to);
}

/** {@link assignable} where it needs no walk beneath the two; nothing where it does. */
function assignableWithoutWalk(from: CelType, to: CelType): boolean | undefined {
  // Every type stands where it is itself wanted.
  if (from === to || isDyn(from) || isDyn(to)) return true;
  // An unresolved parameter is an unknown type: it stands where anything is wanted and
  // accepts anything, exactly as `dyn` does. What it does NOT have is members — asking
  // for one has no answer, and the checker refuses there rather than here.
  if (to.kind === "parameter" || from.kind === "parameter") return true;
  if (from.kind === "primitive" && to.kind === "primitive") return from.name === to.name;
  return undefined;
}

/** The type of every member a record may hold: each field, each part's patterns and undeclared members, then its own undeclared members'. */
export function recordMemberTypes(record: RecordType): CelType[] {
  const types = [...record.fields.values()];
  for (const part of record.patternParts ?? []) {
    for (const entry of part.fields) if (entry.type !== undefined) types.push(entry.type);
    if (part.additionalFields !== undefined) types.push(part.additionalFields);
  }
  if (record.additionalFields !== undefined) types.push(record.additionalFields);
  return types;
}

/**
 * The one type both arms can be. Unlike assignability this is symmetric, and it is
 * what an aggregate literal's elements and a ternary's branches are reduced through:
 * nothing in common is `dyn`, which is CEL's own reading of a heterogeneous literal.
 *
 * **An unresolved parameter yields to the other side**, so the element type of
 * `[[[[]]]], [], [[[]]]]` is the deepest list rather than `dyn`: an empty aggregate
 * says nothing about its elements and must not erase what a sibling does say.
 *
 * **Null is joined apart**: the two sides are joined without it and null is added back
 * where either admitted it, a side that is only null joining as the other side plus null,
 * so `c ? x : null` is `T|null`. And a union joined with a type it includes is that union.
 *
 * **A union joined with a type it does not include widens by kin** (`TypePairs.joinByKin`).
 */
export function unify(left: CelType, right: CelType): CelType {
  return new TypePairs().join(left, right, true);
}

function isNull(type: CelType): boolean {
  return type.kind === "primitive" && type.name === "null";
}

/**
 * The value type of the string-keyed map a record is: every field, pattern and undeclared
 * member type joined — what a record joined with a map or another record's shape reads. A
 * record holding no member type answers an unresolved parameter, as an empty map literal does.
 */
export function recordValueType(record: RecordType): CelType {
  return new TypePairs().recordValue(record);
}
