/**
 * The recognizer of a library migration's legacy spelling: a rule's `match:`,
 * evaluated as data by this small matcher and never by a JSON Schema validator.
 *
 * The vocabulary is closed and spelled as a subset of the kind-schema grammar —
 * `type`, `required`, `const`, `enum`, and `properties` / `items` holding the
 * same, with `<key>: false` under `properties` for a key that is absent — and it
 * reads as that grammar does: `required` and `properties` judge a map and pass
 * any other value, `items` judges a list and passes any other value.
 *
 * A TAGGED value (`!cel`, `!ref`, an expansion tag, a compiled expression) is
 * opaque: it never satisfies `type`, `const` or `enum`, it is never a map or a
 * list, and as a member it is present, so it satisfies `required`.
 *
 * Browser-safe: no Node built-ins. The Rust twin is held to the matcher vectors
 * in `analyzer/library-migration-conformance/`.
 */
import { isCompiledValue } from "@telorun/sdk";
import { isExpansionSentinel, isTaggedSentinel } from "@telorun/templating";

/** A JSON value type `type:` names. */
export type MigrationMatchType = "null" | "boolean" | "object" | "array" | "number" | "integer" | "string";

/** A rule's `match:`, as written. */
export interface MigrationMatch {
  readonly type?: MigrationMatchType | readonly MigrationMatchType[];
  readonly required?: readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, MigrationMatch | false>>;
  readonly items?: MigrationMatch;
}

/** True for a value written behind a tag, or compiled from one: content a
 *  migration may carry by position but never reads as data. */
export function isOpaqueMigrationValue(value: unknown): boolean {
  return isTaggedSentinel(value) || isExpansionSentinel(value) || isCompiledValue(value);
}

/** A plain map of data: an object that is neither a list nor opaque. */
export function isMigrationMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !isOpaqueMigrationValue(value);
}

/** The `type:` names of a match, as a list. */
export function matchTypes(match: MigrationMatch): readonly MigrationMatchType[] | undefined {
  const type = match.type;
  if (type === undefined) return undefined;
  return typeof type === "string" ? [type] : type;
}

/** True when the match pins its values with `const:` or `enum:`. */
export function pinsValues(match: MigrationMatch): boolean {
  return Object.prototype.hasOwnProperty.call(match, "const") || match.enum !== undefined;
}

function holdsType(type: MigrationMatchType, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return (typeof value === "number" && Number.isFinite(value)) || typeof value === "bigint";
    case "integer":
      return (typeof value === "number" && Number.isInteger(value)) || typeof value === "bigint";
    case "array":
      return Array.isArray(value);
    case "object":
      return isMigrationMap(value);
  }
}

/** JSON equality of two data values: an opaque value equals nothing. */
export function migrationValuesEqual(a: unknown, b: unknown): boolean {
  if (isOpaqueMigrationValue(a) || isOpaqueMigrationValue(b)) return false;
  if (typeof a === "bigint" || typeof b === "bigint") {
    const x = typeof a === "bigint" ? a : typeof a === "number" && Number.isInteger(a) ? BigInt(a) : undefined;
    const y = typeof b === "bigint" ? b : typeof b === "number" && Number.isInteger(b) ? BigInt(b) : undefined;
    return x !== undefined && x === y;
  }
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => migrationValuesEqual(item, b[i]));
  }
  if (isMigrationMap(a) && isMigrationMap(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    const other = Object.keys(b).filter((key) => b[key] !== undefined);
    if (keys.length !== other.length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && migrationValuesEqual(a[key], b[key]));
  }
  return false;
}

function present(map: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key) && map[key] !== undefined;
}

/** True when `value` satisfies `match`. */
export function migrationMatchHolds(match: MigrationMatch, value: unknown): boolean {
  const opaque = isOpaqueMigrationValue(value);
  const types = matchTypes(match);
  if (types && (opaque || !types.some((type) => holdsType(type, value)))) return false;
  if (Object.prototype.hasOwnProperty.call(match, "const") && !migrationValuesEqual(match.const, value)) return false;
  if (match.enum && !match.enum.some((candidate) => migrationValuesEqual(candidate, value))) return false;
  if (isMigrationMap(value)) {
    if (match.required && !match.required.every((key) => present(value, key))) return false;
    for (const [key, member] of Object.entries(match.properties ?? {})) {
      if (member === false) {
        if (present(value, key)) return false;
      } else if (present(value, key) && !migrationMatchHolds(member, value[key])) {
        return false;
      }
    }
  }
  if (Array.isArray(value) && match.items) {
    const items = match.items;
    if (!value.every((item) => migrationMatchHolds(items, item))) return false;
  }
  return true;
}
