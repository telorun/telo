import {
  expansionTagMisuse,
  expansionTagOf,
  isExpansionSentinel,
  SPLICE_KEY,
  type ExpansionSentinel,
} from "@telorun/templating";
import type { Document } from "yaml";
import type { ParseError } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import type { DocumentPosition } from "./position-metadata.js";
import type { Range } from "./types.js";

/**
 * The expansion refusals the LOADER makes — the ones that stop it building the
 * module graph, so no later pass can judge them:
 *
 * - an expansion tag written on a scalar or a sequence, or a tagged mapping
 *   writing the marker key itself (`expansionTagMisuse`, templating) — the loaded
 *   tree cannot show either;
 * - an expansion construct at a value the loader itself reads: the module doc's
 *   `metadata` (and `metadata.name`), `imports:` (the block, an entry) and
 *   `include:` (the block, an entry), and an import's own alias, kind, source
 *   and integrity, and a splice at its top level ({@link importFieldRefusals}) —
 *   an `imports:` entry's and a top-level `Telo.Import`'s here, a scope
 *   member's in the loader's scoped-import walk. `!if` / `!switch` there are `BRANCH_POSITION_INVALID`,
 *   `!for-each` and a `...` splice `REPEAT_OUTSIDE_TEMPLATE`.
 *
 * Every other position is the analyzer's (`expansion-sites.ts`), which skips
 * these so each construct is reported once. They are parse diagnostics: they
 * mark the file compromised, holding back the missing-alias cascade, and the
 * kernel refuses the load before analysis.
 */
export function loaderExpansionRefusals(
  text: string,
  documents: readonly Document[],
  manifests: ReadonlyArray<unknown>,
  positions: readonly DocumentPosition[],
): ParseError[] {
  const errors: ParseError[] = [];
  let lineStarts: number[] | undefined;
  const rangeOfOffsets = (start: number, end: number): Range => {
    lineStarts ??= lineStartsOf(text);
    return { start: positionAt(lineStarts, start), end: positionAt(lineStarts, end) };
  };

  documents.forEach((document, documentIndex) => {
    for (const misuse of expansionTagMisuse(document)) {
      errors.push({
        documentIndex,
        code: misuse.code,
        message: misuse.message,
        ...(misuse.range ? { range: rangeOfOffsets(misuse.range[0], misuse.range[1]) } : {}),
      });
    }
  });

  manifests.forEach((manifest, documentIndex) => {
    if (!manifest || typeof manifest !== "object" || isExpansionSentinel(manifest)) return;
    const doc = manifest as Record<string, unknown>;
    const index = positions[documentIndex]?.positionIndex;
    const refuseImportField = (refusal: ImportFieldRefusal, prefix: string) => {
      const path = prefix + refusal.place;
      const range = index?.get(path);
      errors.push({ documentIndex, code: refusal.code, message: refusal.message, path, ...(range ? { range } : {}) });
    };
    if (isImportDocument(doc)) {
      for (const refusal of importFieldRefusals(doc, importAliasOf(doc))) refuseImportField(refusal, "");
      return;
    }
    if (typeof doc.kind !== "string" || !isModuleKind(doc.kind)) return;
    const refuse = (path: string, construct: string, code: LoaderRefusalCode, reads: string) => {
      const range = index?.get(path);
      errors.push({
        documentIndex,
        code,
        message:
          `${construct} at '${path}' of the ${doc.kind} document: the loader reads ${reads} ` +
          `before anything is expanded, so it cannot be chosen or repeated. Write it plainly.`,
        ...(range ? { range } : {}),
      });
    };
    const check = (value: unknown, path: string, reads: string): void => {
      const tag = expansionTagOf(value);
      if (tag) refuse(path, `'!${tag}'`, tag === "for-each" ? REPEAT : BRANCH, reads);
    };
    const checkSplice = (value: unknown, path: string, reads: string): void => {
      if (value && typeof value === "object" && !Array.isArray(value) && SPLICE_KEY in value) {
        refuse(`${path}.${SPLICE_KEY}`, `A '${SPLICE_KEY}' splice`, REPEAT, reads);
      }
    };

    check(doc.metadata, "metadata", "the module's name");
    checkSplice(doc.metadata, "metadata", "the module's name");
    if (doc.metadata && typeof doc.metadata === "object" && !isExpansionSentinel(doc.metadata)) {
      check((doc.metadata as Record<string, unknown>).name, "metadata.name", "the module's name");
    }

    check(doc.imports, "imports", "every import");
    checkSplice(doc.imports, "imports", "every import");
    if (doc.imports && typeof doc.imports === "object" && !Array.isArray(doc.imports) && !isExpansionSentinel(doc.imports)) {
      for (const [alias, entry] of Object.entries(doc.imports as Record<string, unknown>)) {
        if (alias === SPLICE_KEY) continue;
        const path = `imports.${alias}`;
        check(entry, path, "every import");
        if (entry && typeof entry === "object" && !Array.isArray(entry) && !isExpansionSentinel(entry)) {
          for (const refusal of importFieldRefusals(entry as Record<string, unknown>, alias, ["source", "integrity"])) {
            refuseImportField(refusal, `${path}.`);
          }
        }
      }
    }

    check(doc.include, "include", "the files it includes");
    if (Array.isArray(doc.include)) {
      doc.include.forEach((entry, i) => check(entry, `include[${i}]`, "the files it includes"));
    }
  });

  return errors;
}

const BRANCH = "BRANCH_POSITION_INVALID";
const REPEAT = "REPEAT_OUTSIDE_TEMPLATE";
type LoaderRefusalCode = typeof BRANCH | typeof REPEAT;

/** One expansion construct at an import's own field, or a splice at its top level. */
export interface ImportFieldRefusal {
  readonly code: LoaderRefusalCode;
  /** Its place inside the import: `...`, `source`, `integrity`, `kind`,
   *  `metadata`, `metadata.name`, `metadata....`. */
  readonly place: string;
  readonly message: string;
}

const IMPORT_FIELDS = ["kind", "metadata", "source", "integrity"] as const;

/**
 * Every expansion construct at the fields of an import the loader reads before
 * anything is expanded — its kind, its alias (`metadata`, `metadata.name`), its
 * source and its integrity — and a `...` splice at its top level, which may
 * write any of them, on an `imports:` entry (`fields` its `source` and
 * `integrity`), a top-level `Telo.Import` or a scope member. `alias` is the
 * import's name where it is written plainly, which labels each message.
 */
export function importFieldRefusals(
  record: Readonly<Record<string, unknown>>,
  alias: string | undefined,
  fields: readonly (typeof IMPORT_FIELDS)[number][] = IMPORT_FIELDS,
): ImportFieldRefusal[] {
  const out: ImportFieldRefusal[] = [];
  const label = alias !== undefined ? `Telo.Import/${alias}: ` : "";
  const refuse = (place: string, construct: string, code: LoaderRefusalCode) =>
    out.push({
      code,
      place,
      message:
        `${label}${construct} at '${place}' of the Telo.Import: the loader reads an import's alias and ` +
        `source before anything is expanded, so they cannot be chosen or repeated. Write them plainly.`,
    });
  const check = (value: unknown, place: string) => {
    const tag = expansionTagOf(value);
    if (tag) refuse(place, `'!${tag}'`, tag === "for-each" ? REPEAT : BRANCH);
  };
  // A splice at the import's own top level may write any field the loader reads.
  if (SPLICE_KEY in record) refuse(SPLICE_KEY, `A '${SPLICE_KEY}' splice`, REPEAT);
  for (const field of fields) {
    const value = record[field];
    check(value, field);
    if (field !== "metadata" || !value || typeof value !== "object" || Array.isArray(value) || isExpansionSentinel(value)) continue;
    if (SPLICE_KEY in value) refuse(`metadata.${SPLICE_KEY}`, `A '${SPLICE_KEY}' splice`, REPEAT);
    check((value as Record<string, unknown>).name, "metadata.name");
  }
  return out;
}

/** True for an import: `kind: Telo.Import`, or a `kind:` written behind a tag
 *  one of whose options, at any depth, names `Telo.Import`. */
export function isImportDocument(record: Readonly<Record<string, unknown>>): boolean {
  return record.kind === "Telo.Import" || (isExpansionSentinel(record.kind) && optionNamesImport(record.kind));
}

function optionNamesImport(sentinel: ExpansionSentinel): boolean {
  const body = sentinel as Record<string, unknown>;
  const options =
    expansionTagOf(sentinel) === "if"
      ? [body.then, body.else]
      : expansionTagOf(sentinel) === "switch"
        ? [...(body.cases && typeof body.cases === "object" ? Object.values(body.cases) : []), body.default]
        : [body.emit];
  return options.some((option) =>
    option === "Telo.Import" ||
    (Array.isArray(option) ? option : [option]).some((o) => isExpansionSentinel(o) && optionNamesImport(o)),
  );
}

/** The alias an import names where it is written plainly. */
export function importAliasOf(record: Readonly<Record<string, unknown>>): string | undefined {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object" || isExpansionSentinel(metadata)) return undefined;
  const name = (metadata as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** True for an import the loader refuses at one of its own fields: it is read
 *  no further — resolved by no load, registering no alias, analysed by no pass. */
export function isRefusedImport(record: Readonly<Record<string, unknown>>): boolean {
  return isImportDocument(record) && importFieldRefusals(record, undefined).length > 0;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function positionAt(lineStarts: readonly number[], offset: number): { line: number; character: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - lineStarts[low]! };
}
