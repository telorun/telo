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
 * - `record` — an object with named fields, each typed in turn; `open` says whether
 *   a field it does not declare is unjudged (a schema with no `properties`) or
 *   undeclared (a closed schema).
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
  readonly element: CelType;
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
  /** A field the record does not declare is unjudged when open, undeclared when closed. */
  readonly open: boolean;
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
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "dyn":
      return true;
    case "primitive":
      return left.name === (right as PrimitiveType).name;
    case "list":
      return typesEqual(left.element, (right as ListType).element);
    case "map": {
      const other = right as MapType;
      return typesEqual(left.key, other.key) && typesEqual(left.value, other.value);
    }
    case "optional":
      return typesEqual(left.value, (right as OptionalType).value);
    case "record": {
      const other = right as RecordType;
      if (left.name !== other.name || left.open !== other.open || left.fields.size !== other.fields.size) {
        return false;
      }
      for (const [field, type] of left.fields) {
        const held = other.fields.get(field);
        if (!held || !typesEqual(type, held)) return false;
      }
      return true;
    }
    case "union": {
      const other = right as UnionType;
      return (
        left.members.length === other.members.length &&
        left.members.every((member, at) => typesEqual(member, other.members[at]!))
      );
    }
    case "nominal": {
      const other = right as NominalType;
      return (
        left.name === other.name &&
        left.args.length === other.args.length &&
        left.args.every((argument, at) => typesEqual(argument, other.args[at]!))
      );
    }
    case "parameter":
      return left.name === (right as ParameterType).name;
  }
}

/**
 * How a type is written. `top` collapses a list or map of `dyn` to its bare name,
 * which is how the whole type of an expression is reported.
 */
export function formatType(type: CelType, top = false): string {
  switch (type.kind) {
    case "dyn":
      return "dyn";
    case "primitive":
      return PRIMITIVE_PRINTED[type.name];
    case "list":
      return top && isDyn(type.element) ? "list" : `list<${formatType(type.element)}>`;
    case "map":
      return top && isDyn(type.key) && isDyn(type.value)
        ? "map"
        : `map<${formatType(type.key)}, ${formatType(type.value)}>`;
    case "optional":
      return `optional<${formatType(type.value)}>`;
    case "record":
      // An unnamed record is the shape a map has at runtime, and that is how a
      // message names it; its fields are what a diagnostic lists, not its type.
      return type.name ?? "map";
    case "union":
      return type.members.map((member) => formatType(member)).join("|");
    case "nominal":
      return type.args.length === 0
        ? type.name
        : `${type.name}<${type.args.map((argument) => formatType(argument)).join(", ")}>`;
    case "parameter":
      return type.name;
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
  switch (type.kind) {
    case "parameter":
      return DYN;
    case "list": {
      const element = withoutParameters(type.element);
      return element === type.element ? type : listOf(element);
    }
    case "map": {
      const key = withoutParameters(type.key);
      const value = withoutParameters(type.value);
      return key === type.key && value === type.value ? type : mapOf(key, value);
    }
    case "optional": {
      const value = withoutParameters(type.value);
      return value === type.value ? type : optionalOf(value);
    }
    case "union":
      return unionOf(type.members.map(withoutParameters));
    case "nominal": {
      const args = type.args.map(withoutParameters);
      return args.every((argument, at) => argument === type.args[at]) ? type : { ...type, args };
    }
    case "record": {
      let moved = false;
      const fields = new Map<string, CelType>();
      for (const [name, held] of type.fields) {
        const replaced = withoutParameters(held);
        if (replaced !== held) moved = true;
        fields.set(name, replaced);
      }
      return moved ? { ...type, fields } : type;
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
  if (isDyn(from) || isDyn(to)) return true;
  // An unresolved parameter is an unknown type: it stands where anything is wanted and
  // accepts anything, exactly as `dyn` does. What it does NOT have is members — asking
  // for one has no answer, and the checker refuses there rather than here.
  if (to.kind === "parameter" || from.kind === "parameter") return true;
  if (from.kind === "union") return from.members.every((member) => assignable(member, to));
  if (to.kind === "union") return to.members.some((member) => assignable(from, member));
  if (from.kind === "nominal" || to.kind === "nominal") return typesEqual(from, to);
  switch (to.kind) {
    case "list":
      return from.kind === "list" && assignable(from.element, to.element);
    case "map":
      return (
        (from.kind === "map" && assignable(from.key, to.key) && assignable(from.value, to.value)) ||
        // A record is a map with named keys, so it stands where a string-keyed map does.
        (from.kind === "record" && assignable(STRING, to.key) && recordValuesAssignable(from, to.value))
      );
    case "optional":
      return from.kind === "optional" && assignable(from.value, to.value);
    case "record":
      return from.kind === "record" && typesEqual(from, to);
    default:
      return typesEqual(from, to);
  }
}

function recordValuesAssignable(record: RecordType, to: CelType): boolean {
  if (isDyn(to)) return true;
  if (record.open) return false;
  return [...record.fields.values()].every((type) => assignable(type, to));
}

/**
 * The one type both arms can be. Unlike assignability this is symmetric, and it is
 * what an aggregate literal's elements and a ternary's branches are reduced through:
 * nothing in common is `dyn`, which is CEL's own reading of a heterogeneous literal.
 *
 * **An unresolved parameter yields to the other side**, so the element type of
 * `[[[[]]]], [], [[[]]]]` is the deepest list rather than `dyn`: an empty aggregate
 * says nothing about its elements and must not erase what a sibling does say.
 */
export function unify(left: CelType, right: CelType): CelType {
  if (typesEqual(left, right)) return left;
  if (left.kind === "parameter") return right;
  if (right.kind === "parameter") return left;
  if (isDyn(left) || isDyn(right)) return DYN;
  if (left.kind === "list" && right.kind === "list") return listOf(unify(left.element, right.element));
  if (left.kind === "map" && right.kind === "map") {
    return mapOf(unify(left.key, right.key), unify(left.value, right.value));
  }
  if (left.kind === "optional" && right.kind === "optional") return optionalOf(unify(left.value, right.value));
  return DYN;
}
