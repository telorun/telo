/**
 * **A value type with members, at runtime** — the kernel's half of a URL and of any type
 * whose entry declares `members`.
 *
 * A literal at such a slot is read before validation, by the analyzer's decoding walk
 * (`decodePlainLiterals`), and refused by validation with the type's own code. An
 * expression is only a stand-in then, so once compile-eval expansion has produced its
 * result the value is BUILT here — text decoded, an object of members built — and held to
 * the slot's type arguments. A value that does not build is an entry carrying the type's
 * own code (`ERR_URL_INVALID`), its pointer and its reason, never the value: raised as
 * itself at creation, carried inside `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` at a
 * contract boundary. Every value of the type found is handed back as the texts a
 * load-time site adds to its redaction set: the whole text and each sensitive member. A
 * dispatch site adds none; the observability writers censor such a value by value.
 */
import {
  boundArgumentRefusal,
  type ExternalSchemaResolver,
  mapTextLeaves,
  membersRefusalCode,
  membersSlotOf,
  membersValueRefusal,
  readMembersValue,
  type MembersSlot,
} from "@telorun/analyzer";
import {
  isCelRecord,
  isCompiledValue,
  membersEntryOfValue,
  redactedTextsOf,
  RuntimeError,
  valueIssue,
  X_TELO_TYPE,
} from "@telorun/sdk";
import type { SchemaValidator } from "./schema-validator.js";

/** The refusal a members slot's value earns where it is raised as itself — at a
 *  resource's creation or an import's need supply: the type's own code. */
export function membersRefusal(slot: MembersSlot, label: string, message: string): RuntimeError {
  return new RuntimeError(membersRefusalEntry(slot, "/", "").code, `${label}: ${message}`);
}

/** Whether a value satisfies a schema — the one question an argument check asks of
 *  whichever validator its caller holds. */
export type SchemaAccepts = (schema: Record<string, any>, value: unknown) => boolean;

/** The kernel's shared validator as a {@link SchemaAccepts}, a compile per schema node. */
export function acceptsBy(validator: SchemaValidator): SchemaAccepts {
  return (schema, value) => validator.compile(schema, { persist: false }).isValid(value);
}

/** A slot's own annotation as a schema of its own, one object per annotation so a repeat
 *  check reuses the compiled validator. */
const annotationSchemas = new WeakMap<object, Record<string, any>>();

/**
 * Why `value`, already of the slot's type, is refused by the slot's type arguments — or
 * undefined when every argument accepts it. Judged by a validator, so an argument is any
 * schema; the reason names the argument where it is an `enum` or a `const`.
 */
export function membersArgumentRefusal(
  schema: Record<string, any>,
  slot: MembersSlot,
  value: unknown,
  accepts: SchemaAccepts,
): string | undefined {
  const annotation = schema[X_TELO_TYPE];
  if (typeof annotation !== "object" || annotation === null) return undefined;
  let own = annotationSchemas.get(annotation);
  if (!own) annotationSchemas.set(annotation, (own = { [X_TELO_TYPE]: annotation }));
  if (accepts(own, value)) return undefined;
  return boundArgumentRefusal(slot, value) ?? membersValueRefusal(slot, value);
}

/** A value of a type with members that does not build, as every refusal carries it:
 *  where it is, the type's own runtime code, and why — never the value. */
export interface MembersRefusalEntry {
  /** JSON Pointer of the value inside what was built (`/url`, `/` for the whole). */
  readonly pointer: string;
  /** The type's code, `ERR_`-prefixed (`ERR_URL_INVALID`). */
  readonly code: string;
  /** The type's name (`Telo.Url`). */
  readonly type: string;
  readonly reason: string;
}

/** An entry as one line of a refusal: `ERR_URL_INVALID: not a Telo.Url — <reason>`. */
export function membersEntryText(entry: Pick<MembersRefusalEntry, "code" | "type" | "reason">): string {
  return `${entry.code}: not a ${entry.type} — ${entry.reason}`;
}

/** The entry a members slot's refusal is carried as. */
export function membersRefusalEntry(slot: MembersSlot, pointer: string, reason: string): MembersRefusalEntry {
  const code = membersRefusalCode(slot);
  return {
    pointer,
    code: code ? `ERR_${code}` : "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
    type: slot.entry.name,
    reason,
  };
}

/**
 * Build what `written` holds at a members slot — text decoded, an object of members built,
 * a value as it is — held to the slot's arguments; or why it does not build.
 */
export function settleMembersValue(
  schema: Record<string, any>,
  slot: MembersSlot,
  written: unknown,
  accepts: SchemaAccepts,
): { readonly value: unknown } | { readonly reason: string } {
  const read = readMembersValue(slot, written);
  const reason =
    "refusal" in read ? read.refusal : membersArgumentRefusal(schema, slot, read.value, accepts);
  return reason === undefined ? { value: (read as { value: unknown }).value } : { reason };
}

/** What building a value's members-type values found. */
export interface MembersBuild {
  /** Texts the value's owner must redact: each built value's whole text and sensitive members. */
  readonly redacted: string[];
  /** Every value that did not build, left as written. */
  readonly refusals: MembersRefusalEntry[];
}

/**
 * Build, in place, every value of a type with members a value holds as text or as an
 * object of members — a resource's expanded configuration, a call's arguments, a result —
 * and hold each, built here or already one, to its slot's arguments. A value that does not
 * build is left as written and reported; the caller decides what refusal carries it.
 */
export function buildMembersValues(
  resource: unknown,
  schema: Record<string, any>,
  accepts: SchemaAccepts,
  external?: ExternalSchemaResolver,
): MembersBuild {
  const redacted: string[] = [];
  const refusals: MembersRefusalEntry[] = [];
  const settle = (slotSchema: Record<string, any>, slot: MembersSlot, written: unknown, pointer: string): unknown => {
    const settled = settleMembersValue(slotSchema, slot, written, accepts);
    if ("reason" in settled) {
      refusals.push(membersRefusalEntry(slot, pointer || "/", settled.reason));
      return written;
    }
    redacted.push(...redactedTextsOf(settled.value));
    return settled.value;
  };
  mapTextLeaves(
    resource,
    schema,
    (slotSchema, text, pointer) => {
      const slot = membersSlotOf(slotSchema);
      return slot ? settle(slotSchema, slot, text, pointer) : text;
    },
    external,
    schema,
    (slotSchema, node, pointer) => {
      const slot = membersSlotOf(slotSchema);
      if (slot && slot.binding.holds(node)) settle(slotSchema, slot, node, pointer);
    },
    (slotSchema, record, pointer) => {
      const slot = membersSlotOf(slotSchema);
      if (!slot || Object.values(record).some(isCompiledValue)) return undefined;
      return settle(slotSchema, slot, record, pointer);
    },
  );
  return { redacted, refusals };
}

/**
 * What a load-time site redacts for a value already built: the texts of every value of a
 * type with members it holds, at any depth — each one's whole text and sensitive members.
 * Only arrays and plain records are entered.
 */
export function redactedTextsWithin(value: unknown, entered = new Set<object>()): string[] {
  if (typeof value !== "object" || value === null || entered.has(value)) return [];
  if (membersEntryOfValue(value)) return redactedTextsOf(value);
  if (!Array.isArray(value) && !isCelRecord(value)) return [];
  entered.add(value);
  const held = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return held.flatMap((item) => redactedTextsWithin(item, entered));
}

/** A refusal's entries as the `issues` an error's data carries: each a finding in the
 *  issue vocabulary — its pointer (empty for the value itself), `format` naming the
 *  type — beside the type's code. The reason stays in the message. */
export function membersIssues(refusals: readonly MembersRefusalEntry[]): Array<{
  pointer: string;
  keyword: string;
  params: Readonly<Record<string, unknown>>;
  code: string;
}> {
  return refusals.map((entry) => ({
    ...valueIssue(entry.pointer === "/" ? "" : entry.pointer, "format", { format: entry.type }),
    code: entry.code,
  }));
}

/** Arrays and plain records copied, every other value shared — what building in place
 *  writes into, so a caller's own value is left as it handed it over. */
export function copyPlainContainers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyPlainContainers);
  if (!isCelRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, held]) => [key, copyPlainContainers(held)]),
  );
}
