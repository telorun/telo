/**
 * Zone attributes — what an `x-telo-provides-zone` object form declares about
 * the region a body slot establishes, and the single accessor every surface
 * reads that vocabulary through (the `value-type.ts` precedent, itself the
 * `ref-slot.ts` one).
 *
 * A body slot that CONSTRAINS its contents is a body slot that already
 * ESTABLISHES a zone — a transaction, a lease, an idempotency claim, a durable
 * run are all of them — so the constraints are attributes on the annotation
 * rather than a second annotation family that would have to restate the zone's
 * location, its `extends` resolution and its runtime open call.
 *
 * THE VOCABULARY IS DATA; THE MEANING IS THE CONSUMER'S. Entries live at
 * `sdk/zone-attributes/*.json` (see the README there) and are copied in by the
 * root `prepare`. Both kernels read the identical files, because `noSuspend` is
 * what stops a run parking inside a lease wherever that run executes. An entry
 * declares a name, a value schema and its `requires:` dependencies, and no code:
 * there is nothing per entry to implement.
 *
 * THE SET IS CLOSED. `x-telo-ref`'s `use` is a closed set on the same annotation
 * family and nothing has needed to extend it; capabilities and value types are
 * closed. The argument for openness inverts on inspection — `metadata.categories`
 * is open precisely because NOTHING BRANCHES ON IT, while every zone attribute
 * exists to be branched on and every reader is core. And a third-party attribute
 * could only ever be HALF an attribute: a module cannot contribute an analyzer
 * pass, so it would get a runtime reader here and no static check, while the
 * failure directions that justify validating this vocabulary at all — an unread
 * `noSuspend`, an unread `atomic` — are exactly the ones only a static check
 * catches.
 *
 * THE REGISTRY IS IN THE SDK for the reasons the value-type one is: it is
 * dependency-free and Node-built-in-free (so the browser-side analyzer can read
 * it), and it is the only placement a module controller can reach.
 */

import type { ZoneEntry } from "./cancellation.js";
import { ZONE_ATTRIBUTE_ENTRY_FILES } from "./zone-attributes/entries/index.js";

/** One zone attribute, exactly as its entry file declares it. */
export interface ZoneAttributeEntry {
  /** The bare name an author writes as a key inside the annotation. Bare rather
   *  than `Telo.`-qualified because the position already implies the namespace
   *  and a closed set has no second namespace to disambiguate against. */
  readonly name: string;
  /** JSON Schema the declared value must satisfy — always the author's REASON,
   *  required by being the value itself rather than a sibling of a boolean. That
   *  is also what makes a type check possible at all: there is no `true` to
   *  accept, so `atomic: true` fails this schema. */
  readonly value: Record<string, unknown>;
  /** Attributes that must be declared alongside this one. Compiled to JSON
   *  Schema's `dependentRequired`, so the completeness rule lives in the data
   *  beside the thing it constrains rather than as a hardcoded pair of names. */
  readonly requires: readonly string[];
  readonly description: string;
}

class ZoneAttributeEntryError extends Error {
  constructor(file: string, detail: string) {
    super(`Invalid zone-attribute entry '${file}': ${detail}`);
    this.name = "ZoneAttributeEntryError";
  }
}

const ENTRY_KEYS = ["name", "value", "requires", "description", "$comment"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(file: string, node: Record<string, unknown>, key: string): string {
  const value = node[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ZoneAttributeEntryError(file, `'${key}' must be a non-empty string`);
  }
  return value;
}

/**
 * Read one entry file's parsed data.
 *
 * Reading is STRICT and the vocabulary is closed at every level, for the reason
 * the value-type reader is: a malformed or typo'd entry's only other outcome is
 * an attribute that quietly is not in the vocabulary — which reads to an author
 * as "unknown name", pointing at their manifest instead of at the entry.
 */
export function parseZoneAttributeEntry(file: string, data: unknown): ZoneAttributeEntry {
  if (!isPlainObject(data)) throw new ZoneAttributeEntryError(file, "an entry must be a mapping");
  for (const key of Object.keys(data)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new ZoneAttributeEntryError(
        file,
        `an entry has no key '${key}'. Known keys: ${ENTRY_KEYS.join(", ")}.`,
      );
    }
  }

  const name = requireString(file, data, "name");
  // Bare names, checked here rather than left to convention: a qualified one
  // would be a key nothing resolves, and the closed set has nothing to qualify
  // against.
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
    throw new ZoneAttributeEntryError(
      file,
      `'name' must be a bare camelCase word — the annotation position already implies ` +
        `the namespace, and a closed set has no second namespace to qualify against`,
    );
  }

  if (!isPlainObject(data.value)) {
    throw new ZoneAttributeEntryError(file, "'value' must be a JSON Schema mapping");
  }

  const requires = data.requires === undefined ? [] : data.requires;
  if (!Array.isArray(requires) || requires.some((r) => typeof r !== "string" || !r)) {
    throw new ZoneAttributeEntryError(file, "'requires' must be a sequence of attribute names");
  }
  if (requires.includes(name)) {
    throw new ZoneAttributeEntryError(file, `'requires' names '${name}' itself`);
  }

  return {
    name,
    value: data.value,
    requires: requires as readonly string[],
    description: requireString(file, data, "description"),
  };
}

function buildRegistry(): ReadonlyMap<string, ZoneAttributeEntry> {
  const registry = new Map<string, ZoneAttributeEntry>();
  for (const [file, data] of ZONE_ATTRIBUTE_ENTRY_FILES) {
    const entry = parseZoneAttributeEntry(file, data);
    if (registry.has(entry.name)) {
      throw new ZoneAttributeEntryError(file, `'${entry.name}' is already declared by another entry`);
    }
    registry.set(entry.name, entry);
  }
  // A `requires:` naming an attribute no entry declares would compile to a
  // `dependentRequired` clause nothing can ever satisfy, so every declaration of
  // the depending attribute would be rejected with no way to fix it. Checked
  // after the whole set is read, since entries are order-independent.
  for (const entry of registry.values()) {
    for (const dependency of entry.requires) {
      if (!registry.has(dependency)) {
        throw new ZoneAttributeEntryError(
          `${entry.name}.json`,
          `'requires' names '${dependency}', which no entry declares`,
        );
      }
    }
  }
  // Defence in depth against the packaging mistake, whose failure is
  // indistinguishable from an author's typo: every declared attribute becomes an
  // unknown name, reported against manifests that are correct.
  if (registry.size === 0) {
    throw new Error(
      "The zone-attribute vocabulary is empty. `sdk/zone-attributes/*.json` did not reach " +
        "this build — check the file allowlist of whatever packaged it. Continuing would " +
        "report every declared attribute as an unknown name, while enforcing none of them.",
    );
  }
  return registry;
}

/** Every declared zone attribute, keyed by its bare name. */
export const ZONE_ATTRIBUTES: ReadonlyMap<string, ZoneAttributeEntry> = buildRegistry();

/** The declared names, in entry order — what a diagnostic listing the closed
 *  vocabulary prints. */
export function zoneAttributeNames(): string[] {
  return [...ZONE_ATTRIBUTES.keys()];
}

/**
 * The attributes a zone declares, keyed by name, with the author's reason as the
 * value.
 *
 * A typed record rather than a string-keyed bag, which the closed vocabulary is
 * what makes possible. It is a readability gain and NOT a semantic one — the
 * kernel still interprets nothing and branches on no name, exactly as
 * `readRefSlot` hands back `use` without acting on it.
 */
export type ZoneAttributes = {
  readonly [K in "atomic" | "idempotent" | "noSuspend" | "replayed"]?: string;
};

/**
 * One open zone, paired with what it declares about everything inside it.
 *
 * The kind is carried so a consumer can name the zone in a diagnostic — "the
 * `Sql.Transaction` you are inside forbids parking" — while the attributes are
 * what it actually branches on.
 */
export interface OpenZoneAttributes {
  /** Canonical `<module>.<Kind>` of the providing kind. */
  readonly kind: string;
  /** What this zone declares, with each author's reason as the value. */
  readonly attributes: ZoneAttributes;
  /** The open entry itself, so a consumer that must ASK something about this
   *  particular zone has it in hand — a durable journal answering "do my writes
   *  land inside your atomicity?" needs the entry, not the kind.
   *
   *  This is not the rejected "attributes on the entry" shape inverted: the
   *  entry stays three identities and carries nothing new, it merely travels
   *  BESIDE the attributes instead of being looked up again by a caller that
   *  would have to re-walk the stack to find it. */
  readonly entry: ZoneEntry;
}
