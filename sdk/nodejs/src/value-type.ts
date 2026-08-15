/**
 * `x-telo-type` — the one annotation that says what the value at a slot IS,
 * beyond what JSON Schema's `type` vocabulary can express, and the single
 * accessor every surface reads it through (the `ref-slot.ts` precedent).
 *
 * It replaced three keywords that answered one question differently: a nominal
 * brand from a closed kernel table (`x-telo-type: TcpPort`), raw bytes
 * (`x-telo-binary: true`), and a live handle (`x-telo-stream: true`). They
 * differed in POSTURE toward the JSON Schema layer — refine, replace, exempt —
 * not in kind, so each spelled as its own keyword meant a fourth cost eleven
 * files across four packages, and left three defects: a typo'd brand degraded
 * silently, bytes had no CEL identity, and a module string-matched the keyword
 * because there was nothing on its surface to read.
 *
 * THE VOCABULARY IS DATA; THE BINDING TO A LANGUAGE IS NOT. Entries live at
 * `sdk/value-types/*.json` (see the README there) and are copied in by the SDK's
 * `prepare`. Every runtime that hosts Telo reads the same files — the Rust half
 * types an `!include-bytes` slot from them in a kernel with no CEL engine — so
 * an entry declares a symbolic `binding`, never a constructor name, and each
 * runtime carries its own table mapping that key to its own identity.
 *
 * THE REGISTRY IS IN THE SDK because it is dependency-free and Node-built-in-free
 * (so a browser-side analyzer can read it), because `Stream` already lives here,
 * and because it is the only placement a module controller can reach: a module
 * may import `@telorun/sdk` and nothing else.
 */

import { Stream } from "./stream.js";
import { VALUE_TYPE_ENTRY_FILES } from "./value-types/entries/index.js";

export const X_TELO_TYPE = "x-telo-type";

/** How a value is represented, which is the one thing an entry declares.
 *
 *  - `json`     — an ordinary value its declared schema already validates. The
 *                 name adds nominal identity for static wiring, nothing else.
 *  - `instance` — not JSON at all. This is what makes a value unauthorable: no
 *                 YAML literal is ever a byte buffer or a stream handle. */
export type ValueTypeRepresentation = "json" | "instance";

/** A named type parameter. Every parameter is optional and defaults to *any*,
 *  so an unparameterized use of a generic type stays legal. Named rather than
 *  positional so a diagnostic can say `of` instead of "argument 0", and so a
 *  second parameter can be added without a migration. */
export interface ValueTypeParameter {
  readonly name: string;
  /** This parameter's argument is what ITERATING a value of the type yields.
   *  Declared here so "what is the element of this collection" is answered by
   *  the vocabulary rather than by a consumer that knows one type's name — the
   *  same reason `live` is a field and not a check against `Telo.Stream`. At
   *  most one parameter per entry may carry it. */
  readonly element?: boolean;
  readonly description?: string;
}

/** One value type, exactly as its entry file declares it. */
export interface ValueTypeEntry {
  /** `Telo.`-qualified. The closed vocabulary an author writes at the name slot. */
  readonly name: string;
  readonly representation: ValueTypeRepresentation;
  /** `json` only — the JSON Schema type this name refines. */
  readonly base?: string;
  /** `instance` only — the symbolic key a runtime's binding table maps. */
  readonly binding?: string;
  /** An instance whose consumption has effects, so it is exempt from validation
   *  rather than asserted. Exemption is from VALIDATION, never from TYPING. */
  readonly live: boolean;
  readonly parameters: readonly ValueTypeParameter[];
  readonly description: string;
}

/** What one runtime can say about an `instance` representation. Node's identity
 *  is a constructor (`instanceof` is the assertion) plus the CEL type an
 *  expression at such a slot carries. */
export interface ValueTypeBinding {
  /** The constructor an assertion tests against. `Buffer` extends `Uint8Array`,
   *  so a Node buffer satisfies `bytes` without a second rule. */
  readonly constructor: Function;
  /** The CEL type a value of this representation carries. */
  readonly celType: string;
  /** A stand-in the analyzer substitutes for a CEL leaf at such a slot, so the
   *  static check and the runtime assertion agree BY CONSTRUCTION rather than by
   *  two rules kept in step. Absent for a `live` type, whose value is never
   *  validated and so needs nothing to satisfy. */
  readonly placeholder?: () => unknown;
}

/**
 * Node's binding table — the ONLY per-language artifact in the whole mechanism.
 *
 * Keyed by an entry's symbolic `binding`, never by its name, so a runtime that
 * represents two entries the same way says so once and a rename of a type does
 * not touch any table.
 */
export const VALUE_TYPE_BINDINGS: Readonly<Record<string, ValueTypeBinding>> = {
  bytes: { constructor: Uint8Array, celType: "bytes", placeholder: () => new Uint8Array() },
  stream: { constructor: Stream, celType: "Stream" },
};

/** The CEL type a `json` representation's declared base carries. A brand's own
 *  name is the CEL type; this is what it degrades to when the consuming slot
 *  declares no brand of its own (gradual typing). */
const CEL_TYPE_FOR_BASE: Readonly<Record<string, string>> = {
  integer: "int",
  number: "double",
  string: "string",
  boolean: "bool",
  array: "list",
  object: "map",
};

class ValueTypeEntryError extends Error {
  constructor(file: string, detail: string) {
    super(`Invalid value-type entry '${file}': ${detail}`);
    this.name = "ValueTypeEntryError";
  }
}

const ENTRY_KEYS = [
  "name",
  "representation",
  "base",
  "binding",
  "live",
  "parameters",
  "description",
  "$comment",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(file: string, node: Record<string, unknown>, key: string): string {
  const value = node[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValueTypeEntryError(file, `'${key}' must be a non-empty string`);
  }
  return value;
}

function readParameters(file: string, raw: unknown): ValueTypeParameter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ValueTypeEntryError(file, "'parameters' must be a sequence");
  const params = raw.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new ValueTypeEntryError(file, `parameters[${i}] must be a mapping`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "description" && key !== "element") {
        throw new ValueTypeEntryError(file, `parameters[${i}] has no key '${key}'`);
      }
    }
    if (entry.element !== undefined && typeof entry.element !== "boolean") {
      throw new ValueTypeEntryError(file, `parameters[${i}].element must be a boolean when present`);
    }
    const name = requireString(file, entry, "name");
    return {
      name,
      ...(entry.element === true ? { element: true as const } : {}),
      ...(entry.description === undefined
        ? {}
        : { description: requireString(file, entry, "description") }),
    };
  });
  // Two element parameters would make "the element of this value" ambiguous, and
  // the reader is the only place that can refuse it — every consumer takes the
  // first match and would silently pick one.
  if (params.filter((p) => p.element).length > 1) {
    throw new ValueTypeEntryError(file, "at most one parameter may declare 'element'");
  }
  return params;
}

/**
 * Read one entry file's parsed data.
 *
 * Reading is STRICT and the vocabulary is closed at every level. A malformed or
 * typo'd entry is an authoring mistake whose only other outcome is a type that
 * quietly is not in the vocabulary — which reads to an author as "unknown name",
 * pointing at their manifest instead of at the entry.
 */
export function parseValueTypeEntry(file: string, data: unknown): ValueTypeEntry {
  if (!isPlainObject(data)) throw new ValueTypeEntryError(file, "an entry must be a mapping");
  for (const key of Object.keys(data)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new ValueTypeEntryError(
        file,
        `an entry has no key '${key}'. Known keys: ${ENTRY_KEYS.join(", ")}.`,
      );
    }
  }

  const name = requireString(file, data, "name");
  if (!name.startsWith("Telo.")) {
    throw new ValueTypeEntryError(
      file,
      `'name' must be Telo.-qualified — a representation is kernel-owned and cannot be module-defined`,
    );
  }
  const representation = requireString(file, data, "representation");
  if (representation !== "json" && representation !== "instance") {
    throw new ValueTypeEntryError(file, `'representation' must be 'json' or 'instance'`);
  }
  if (data.live !== undefined && typeof data.live !== "boolean") {
    throw new ValueTypeEntryError(file, "'live' must be a boolean when present");
  }

  // The two representations take disjoint parameters, and mixing them is a
  // statement with no meaning: a `json` value has no constructor to assert, and
  // an `instance` has no JSON base to refine.
  if (representation === "json") {
    if (data.binding !== undefined) {
      throw new ValueTypeEntryError(file, "a 'json' representation takes no 'binding'");
    }
    const base = requireString(file, data, "base");
    if (!(base in CEL_TYPE_FOR_BASE)) {
      throw new ValueTypeEntryError(
        file,
        `'base' '${base}' is not a JSON Schema type (${Object.keys(CEL_TYPE_FOR_BASE).join(", ")})`,
      );
    }
    if (data.live === true) {
      throw new ValueTypeEntryError(file, "a 'json' representation cannot be 'live' — it is data");
    }
  } else {
    if (data.base !== undefined) {
      throw new ValueTypeEntryError(file, "an 'instance' representation takes no 'base'");
    }
    requireString(file, data, "binding");
  }

  const entry: ValueTypeEntry = {
    name,
    representation,
    ...(representation === "json" ? { base: data.base as string } : { binding: data.binding as string }),
    live: data.live === true,
    parameters: readParameters(file, data.parameters),
    description: requireString(file, data, "description"),
  };
  return entry;
}

function buildRegistry(): ReadonlyMap<string, ValueTypeEntry> {
  const registry = new Map<string, ValueTypeEntry>();
  for (const [file, data] of VALUE_TYPE_ENTRY_FILES) {
    const entry = parseValueTypeEntry(file, data);
    if (registry.has(entry.name)) {
      throw new ValueTypeEntryError(file, `'${entry.name}' is already declared by another entry`);
    }
    // A binding with no row in THIS host's table is a hard error, never a
    // skipped assertion: a type that cannot be asserted would silently exempt
    // every slot declaring it, converting a contract into a hole. The same class
    // of failure as an unrecognized `use` token degrading to the legacy reading.
    if (entry.binding !== undefined && !(entry.binding in VALUE_TYPE_BINDINGS)) {
      throw new ValueTypeEntryError(
        file,
        `binding '${entry.binding}' has no row in this runtime's table — a value type ` +
          `whose assertion cannot be produced would silently exempt every slot that declares it`,
      );
    }
    registry.set(entry.name, entry);
  }
  // Defence in depth against the packaging mistake, because the failure it
  // produces is indistinguishable from an author's typo: every `x-telo-type`
  // becomes an unknown name, reported against manifests that are correct. The
  // build script refuses a missing source directory; this refuses the state that
  // would reach a user if some other path ever produced it.
  if (registry.size === 0) {
    throw new Error(
      "The value-type vocabulary is empty. `sdk/value-types/*.json` did not reach this " +
        "build — check the file allowlist of whatever packaged it. Continuing would report " +
        "every declared value type as an unknown name.",
    );
  }
  return registry;
}

/** Every declared value type, keyed by its `Telo.`-qualified name. */
export const VALUE_TYPES: ReadonlyMap<string, ValueTypeEntry> = buildRegistry();

/** The declared names, in entry order — what `telo cel types` and the generated
 *  docs section enumerate. */
export function valueTypeNames(): string[] {
  return [...VALUE_TYPES.keys()];
}

/** A read `x-telo-type` annotation: the type it names plus its type arguments. */
export interface ValueTypeSlot {
  /** The name exactly as written, which is also the canonical one — the
   *  vocabulary is closed, so there is nothing to resolve. */
  readonly name: string;
  /** The registry entry, or undefined when the name is not a declared type.
   *  Present separately from `name` so a diagnostic can report the name the
   *  author wrote rather than swallowing an unknown one. */
  readonly entry: ValueTypeEntry | undefined;
  /** Type arguments by parameter name. Each value is a schema node. */
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Read the annotation off a schema node.
 *
 * Two spellings, one meaning: a bare name (`x-telo-type: Telo.Bytes`) and the
 * object form carrying arguments (`{ name: Telo.Stream, of: … }`). Returns
 * undefined when the node carries no annotation at all — an unknown NAME still
 * returns a slot, with `entry` undefined, because silently reading it as "no
 * value type" is the degrade this annotation replaced.
 */
export function readValueTypeSlot(schema: unknown): ValueTypeSlot | undefined {
  if (!isPlainObject(schema)) return undefined;
  const raw = schema[X_TELO_TYPE];
  if (raw === undefined) return undefined;

  if (typeof raw === "string") {
    return { name: raw, entry: VALUE_TYPES.get(raw), args: {} };
  }
  if (isPlainObject(raw)) {
    const name = typeof raw.name === "string" ? raw.name : "";
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "name") continue;
      // A bare NAME as an argument is sugar for a schema node carrying only that
      // annotation, so `of: Telo.Bytes` and `of: { x-telo-type: Telo.Bytes }`
      // are one thing. Normalized HERE, in the single reader, so no consumer
      // re-derives it — a comparator that saw the string form would compare a
      // string against a schema and quietly conclude nothing.
      args[key] = typeof value === "string" ? { [X_TELO_TYPE]: value } : value;
    }
    return { name, entry: VALUE_TYPES.get(name), args };
  }
  return { name: "", entry: undefined, args: {} };
}

/** The entry a schema node declares, or undefined. The common read. */
export function valueTypeOf(schema: unknown): ValueTypeEntry | undefined {
  return readValueTypeSlot(schema)?.entry;
}

/** True when this node declares a value type at all (known or not). */
export function isValueTypeSlot(schema: unknown): boolean {
  return readValueTypeSlot(schema) !== undefined;
}

/** True when the node declares a `live` type, so its value is exempt from
 *  validation — never traversed, never asserted. Typing is unaffected. */
export function isLiveSlot(schema: unknown): boolean {
  return valueTypeOf(schema)?.live === true;
}

/** True when the node declares a type represented as a runtime instance —
 *  the values no manifest literal can ever be. */
export function isInstanceSlot(schema: unknown): boolean {
  return valueTypeOf(schema)?.representation === "instance";
}

/**
 * The schema of what iterating a value at this slot yields, or undefined when
 * the slot declares no value type, or one with no element parameter.
 *
 * The whole point of reading it from the entry is that no consumer names a type:
 * a future iterable value type is covered by declaring `element` on its own
 * parameter, with nothing to change here or in the analyzer. An element
 * parameter left unsupplied means *any*, exactly as every other omitted argument
 * does, so an unparameterized use degrades to permissive rather than to nothing.
 */
export function elementSchemaOf(schema: unknown): unknown | undefined {
  const slot = readValueTypeSlot(schema);
  const parameter = slot?.entry?.parameters.find((p) => p.element);
  if (!parameter) return undefined;
  return slot!.args[parameter.name] ?? {};
}

/** The binding row for a schema node's declared type, or undefined when it
 *  declares none / declares a `json` one. */
export function bindingOf(schema: unknown): ValueTypeBinding | undefined {
  const binding = valueTypeOf(schema)?.binding;
  return binding === undefined ? undefined : VALUE_TYPE_BINDINGS[binding];
}

/** The stand-in for a CEL leaf at this slot, or undefined when the slot declares
 *  no instance type (ordinary JSON, so the schema's own shape decides) or a live
 *  one (nothing validates it, so nothing has to satisfy anything). */
export function valueTypePlaceholder(schema: unknown): unknown | undefined {
  return bindingOf(schema)?.placeholder?.();
}

/**
 * The CEL type a value at this slot carries.
 *
 * A `json` representation carries its own NAME as a nominal brand — which is the
 * whole point of one, since a `Telo.TcpPort` and a `Telo.UdpPort` are structurally
 * identical. An `instance` carries whatever its binding says.
 */
export function celTypeOfValueType(entry: ValueTypeEntry): string {
  if (entry.representation === "json") return entry.name;
  const binding = VALUE_TYPE_BINDINGS[entry.binding!];
  return binding!.celType;
}

/** The CEL type a brand degrades to where the consuming slot declares none —
 *  gradual typing, so a `Telo.TcpPort` flows freely into a plain integer field.
 *  Undefined for an `instance`, which has no base to fall back to. */
export function celBaseOfValueType(entry: ValueTypeEntry): string | undefined {
  return entry.representation === "json" ? CEL_TYPE_FOR_BASE[entry.base!] : undefined;
}

/** Every `json` representation's CEL brand → the base type it refines. The
 *  gradual-typing table, derived rather than hand-written. */
export function valueBrandBases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of VALUE_TYPES.values()) {
    const base = celBaseOfValueType(entry);
    if (base !== undefined) out[entry.name] = base;
  }
  return out;
}
