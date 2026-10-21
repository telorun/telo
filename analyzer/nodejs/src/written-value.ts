/**
 * A value as the author wrote it — the one encoding the module graph's `match`
 * and every outline value share.
 *
 * A JSON scalar or array is itself. Every object is an envelope, so a literal
 * mapping can never read as an expression whatever keys it holds:
 *
 *  - a tagged value is `{ tag, source, type? }` — the YAML tag without its `!`,
 *    the text written after it, and the static type where the analyzer has one;
 *  - a literal mapping is `{ map: { … } }`, at every depth.
 *
 * One encoder ({@link writtenValueOf}, {@link writtenLeafOf}) and one reader
 * ({@link readWrittenValue}) for every renderer. A reference is decided by the
 * reference sites the caller names, never by a value's `{kind, name}` shape.
 *
 * Browser-safe: no Node built-ins.
 */
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";

export interface TaggedWrittenValue {
  tag: string;
  source: string;
  type?: string;
}

export interface WrittenMap {
  map: { [key: string]: WrittenValue };
}

export type WrittenScalar = string | number | boolean | null;

export type WrittenValue = WrittenScalar | WrittenValue[] | TaggedWrittenValue | WrittenMap;

export interface WrittenValueContext {
  /** Is the concrete path (`mounts[0].hostnames[1]`) one of the resource's
   *  filled reference sites? */
  isReferenceSite?(path: string): boolean;
  /** The static type of the expression at `path`, when the analyzer has one. */
  typeOf?(path: string, engine: string, source: string): string | undefined;
}

/** A scalar, a reference or a tagged value — `undefined` for a mapping or a
 *  list, which are not leaves, and for nothing written. */
export function writtenLeafOf(
  value: unknown,
  path: string,
  context: WrittenValueContext = {},
): WrittenScalar | TaggedWrittenValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value as WrittenScalar;
  if (context.isReferenceSite?.(path)) {
    const source = writtenRefOf(value);
    if (source !== undefined) return { tag: "ref", source };
  }
  if (isTaggedSentinel(value)) {
    if (isRefSentinel(value)) return { tag: "ref", source: value.source };
    const type = context.typeOf?.(path, value.engine, value.source);
    return { tag: value.engine, source: value.source, ...(type !== undefined ? { type } : {}) };
  }
  return undefined;
}

/** `value` encoded whole, `undefined` when nothing is written. */
export function writtenValueOf(
  value: unknown,
  path: string,
  context: WrittenValueContext = {},
): WrittenValue | undefined {
  const leaf = writtenLeafOf(value, path, context);
  if (leaf !== undefined || value === undefined) return leaf;
  if (Array.isArray(value)) {
    return value.map((item, index) => writtenValueOf(item, `${path}[${index}]`, context) ?? null);
  }
  const entries: Record<string, WrittenValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const written = writtenValueOf(child, path ? `${path}.${key}` : key, context);
    if (written !== undefined) entries[key] = written;
  }
  return writtenMap(entries);
}

/** A literal mapping whose entries are already encoded. */
export function writtenMap(entries: Record<string, WrittenValue>): WrittenMap {
  return { map: entries };
}

/** A reference as the author wrote it — `<name>` or `<Alias>.<name>` — from the
 *  sentinel or from the `{kind, name, alias?}` it resolved into. */
function writtenRefOf(value: unknown): string | undefined {
  if (isRefSentinel(value)) return value.source;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { name, alias } = value as { name?: unknown; alias?: unknown };
  if (typeof name !== "string") return undefined;
  return typeof alias === "string" ? `${alias}.${name}` : name;
}

/** What a written value is, for a renderer. */
export type WrittenValueReading =
  | { form: "scalar"; value: WrittenScalar }
  | { form: "list"; items: readonly WrittenValue[] }
  | { form: "tagged"; tag: string; source: string; type?: string }
  | { form: "map"; entries: readonly (readonly [string, WrittenValue])[] };

const TAGGED_KEYS: ReadonlySet<string> = new Set(["tag", "source", "type"]);

/** Read a value of the encoding. Anything outside it is refused: a renderer
 *  guessing at an object is how a literal mapping came to print as an
 *  expression. */
export function readWrittenValue(value: unknown): WrittenValueReading {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { form: "scalar", value };
  }
  if (typeof value !== "object") throw new TypeError(`Not a written value: a ${typeof value}.`);
  if (Array.isArray(value)) return { form: "list", items: value as WrittenValue[] };
  const keys = Object.keys(value);
  const map = (value as WrittenMap).map;
  if (keys.length === 1 && keys[0] === "map" && map && typeof map === "object" && !Array.isArray(map)) {
    return { form: "map", entries: Object.entries(map) };
  }
  const { tag, source, type } = value as TaggedWrittenValue;
  if (
    typeof tag === "string" &&
    typeof source === "string" &&
    (type === undefined || typeof type === "string") &&
    keys.every((key) => TAGGED_KEYS.has(key))
  ) {
    return { form: "tagged", tag, source, ...(type !== undefined ? { type } : {}) };
  }
  throw new TypeError(
    `Not a written value: an object with keys ${keys.map((key) => `'${key}'`).join(", ") || "(none)"}; ` +
      `an object is either { tag, source, type? } or { map }.`,
  );
}
