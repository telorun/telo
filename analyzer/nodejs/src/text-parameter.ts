/**
 * A library's TEXT PARAMETERS — the `variables:` / `secrets:` entries typed
 * `Text` or `Message` (or a union of either with `TextRecord`), recognised by
 * `textParameterFragment` (`text-slot.ts`).
 *
 * The value an import supplies is a text the IMPORTING module writes: judged in
 * its `lang:` and handed to the library as the record `{ text, context, lang,
 * computed }` attributed to it. An expression there is admitted only where its
 * result can only be a `TextRecord` — a record forwarded unchanged. The entry's
 * `default:` is the library's own text. Inside the library the input reads as a
 * `TextRecord`. An Application entry is never one: a host-supplied value has no
 * writing module.
 *
 * Read by `telo check` (the text pass, the CEL typing of a library's inputs,
 * shared-library agreement) and by the kernel's import settling. Browser-safe.
 */
import { messageIdentity, readMessage, type MessageSource, type TextRecord } from "@telorun/sdk";
import { admitsAbsence } from "./configuration-dimensions.js";
import { liftFragmentDefs, manifestFragmentRef, withSchemaFragments } from "./manifest-schemas.js";
import { recordLangOf } from "./module-lang.js";
import { MESSAGE_FRAGMENT, TEXT_FRAGMENT, textParameterFragment } from "./text-slot.js";

export const TEXT_PARAMETER_BLOCKS = ["variables", "secrets"] as const;
export type TextParameterBlock = (typeof TEXT_PARAMETER_BLOCKS)[number];

/** One text parameter a library declares. */
export interface LibraryTextParameter {
  readonly block: TextParameterBlock;
  readonly name: string;
  readonly fragment: typeof TEXT_FRAGMENT | typeof MESSAGE_FRAGMENT;
  readonly entry: Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** True for a `Telo.Library` document: only a library declares text parameters. */
function isLibraryDocument(doc: unknown): boolean {
  return isPlainObject(doc) && doc.kind === "Telo.Library";
}

/** The text parameters of one block of a library document's entries. */
export function textParametersOfBlock(block: unknown, name: TextParameterBlock): LibraryTextParameter[] {
  if (!isPlainObject(block)) return [];
  const out: LibraryTextParameter[] = [];
  for (const [key, entry] of Object.entries(block)) {
    if (!isPlainObject(entry)) continue;
    const fragment = textParameterFragment(entry);
    if (fragment) out.push({ block: name, name: key, fragment, entry });
  }
  return out;
}

/** Every text parameter a module document declares — none for an Application. */
export function textParametersOf(moduleDoc: unknown): LibraryTextParameter[] {
  if (!isLibraryDocument(moduleDoc)) return [];
  const doc = moduleDoc as Record<string, unknown>;
  return TEXT_PARAMETER_BLOCKS.flatMap((block) => textParametersOfBlock(doc[block], block));
}

let textRecord: Record<string, any> | undefined;

/** The `TextRecord` fragment as a schema root, its definitions hoisted onto it. */
export function textRecordSchema(): Record<string, any> {
  if (!textRecord) {
    const holder = withSchemaFragments({
      type: "object",
      properties: { record: { $ref: manifestFragmentRef("TextRecord") } },
    }) as Record<string, any>;
    textRecord = { ...holder.properties.record, ...(holder.$defs ? { $defs: holder.$defs } : {}) };
  }
  return textRecord!;
}

/** A slot taking a text or a text record: what a text parameter is read as at
 *  an import, where an expression is admitted by the record branch alone. */
export function textOrRecordSchema(entry: Record<string, unknown>): Record<string, unknown> {
  return liftFragmentDefs({ anyOf: [entry, textRecordSchema()] });
}

/**
 * The block a module's own CEL reads: a library's text parameter read as the
 * record the kernel hands over (nullable where the entry may be absent), every
 * other entry as declared. The block itself for any other document or block.
 */
export function moduleInputBlock(moduleDoc: unknown, name: TextParameterBlock): unknown {
  const block = isPlainObject(moduleDoc) ? moduleDoc[name] : undefined;
  if (!isLibraryDocument(moduleDoc) || !isPlainObject(block)) return block;
  const params = textParametersOfBlock(block, name);
  if (params.length === 0) return block;
  const out: Record<string, unknown> = { ...block };
  for (const param of params) {
    out[param.name] = { ...textRecordSchema(), ...(admitsAbsence(param.entry) ? { default: null } : {}) };
  }
  return out;
}

/** The record a holder receives for a `Text` written `value` by a module of
 *  `lang`. */
export function textRecordOf(value: unknown, lang: string | null, computed: boolean): TextRecord {
  const objectForm = isPlainObject(value) && Object.hasOwn(value, "text");
  const text = (objectForm ? (value as { text: unknown }).text : value) as MessageSource;
  const context = objectForm ? ((value as { context?: unknown }).context as string | undefined) ?? null : null;
  return { text, context, lang: recordLangOf(lang), computed };
}

/** What two settled records are compared by: the message core's identity of
 *  the text, its context, its language and whether it was computed. Undefined
 *  for a record whose text does not read. */
export function textRecordIdentity(record: TextRecord): string | undefined {
  const read = readMessage(record.text);
  return read.ok ? JSON.stringify([messageIdentity(read.message), record.context, record.lang, record.computed]) : undefined;
}

/** The two languages two records of one text are written in, when the language
 *  is all that tells them apart. */
export function recordsDifferOnlyInLang(a: TextRecord, b: TextRecord): readonly [string, string] | undefined {
  if (a.lang === b.lang) return undefined;
  const same = textRecordIdentity({ ...a, lang: b.lang });
  return same !== undefined && same === textRecordIdentity(b) ? [a.lang, b.lang] : undefined;
}
