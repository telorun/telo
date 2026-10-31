import { expansionTagMisuse, expansionTagOf, isExpansionSentinel, SPLICE_KEY } from "@telorun/templating";
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
 *   `metadata` (and `metadata.name`), `imports:` (the block, an entry, an entry's
 *   `source`) and `include:` (the block, an entry). `!if` / `!switch` there are
 *   `BRANCH_POSITION_INVALID`, `!for-each` and a `...` splice
 *   `REPEAT_OUTSIDE_TEMPLATE`.
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
    if (typeof doc.kind !== "string" || !isModuleKind(doc.kind)) return;
    const index = positions[documentIndex]?.positionIndex;
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
          check((entry as Record<string, unknown>).source, `${path}.source`, "every import's source");
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
