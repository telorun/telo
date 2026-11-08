/**
 * Applies a SEARCH/REPLACE patch to a text. Each section names a SEARCH that must
 * occur exactly once in the text as the earlier sections left it, and a REPLACE
 * for it. Sections apply in order and all or nothing: a refusal returns no text.
 *
 * A section's SEARCH and REPLACE are their lines, each followed by a newline, so
 * whole lines match whole lines and an empty REPLACE deletes them. A SEARCH
 * matches byte for byte anywhere in the text, mid-line included.
 */

export type PatchCode = "EDIT_BLOCK_MALFORMED" | "EDIT_SECTION_ABSENT" | "EDIT_SECTION_AMBIGUOUS";

export type ApplyPatchResult =
  | { applied: true; text: string; code: null; section: null; lines: null }
  | { applied: false; text: null; code: PatchCode; section: number | null; lines: number[] | null };

export interface ApplyPatchOptions {
  /** The most UTF-8 bytes the text and the patch each may hold. */
  maxInputBytes: number;
}

const SEARCH_MARKER = "<<<<<<< SEARCH";
const DIVIDER = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

interface Section {
  search: string;
  replace: string;
}

/** `section` is the 1-based section the malformation belongs to, null for text outside any. */
interface Malformed {
  malformed: true;
  section: number | null;
}

const malformed = (section: number | null): Malformed => ({ malformed: true, section });

const refused = (code: PatchCode, section: number | null, lines: number[] | null): ApplyPatchResult => ({
  applied: false,
  text: null,
  code,
  section,
  lines,
});

const linesText = (lines: string[]): string => lines.map((line) => `${line}\n`).join("");

function parsePatch(patch: string): Section[] | Malformed {
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  const lines = body.split("\n");
  const sections: Section[] = [];
  let index = 0;
  while (index < lines.length) {
    const number = sections.length + 1;
    if (lines[index] !== SEARCH_MARKER) return malformed(null);
    index++;

    const search: string[] = [];
    while (index < lines.length && lines[index] !== DIVIDER) {
      if (lines[index] === SEARCH_MARKER || lines[index] === REPLACE_MARKER) return malformed(number);
      search.push(lines[index]!);
      index++;
    }
    if (index === lines.length || search.length === 0) return malformed(number);
    index++;

    const replace: string[] = [];
    while (index < lines.length && lines[index] !== REPLACE_MARKER) {
      replace.push(lines[index]!);
      index++;
    }
    if (index === lines.length) return malformed(number);
    index++;

    sections.push({ search: linesText(search), replace: linesText(replace) });
  }
  return sections.length === 0 ? malformed(null) : sections;
}

/** Start indices of every occurrence, overlapping ones included. */
function occurrences(text: string, search: string): number[] {
  const found: number[] = [];
  let at = text.indexOf(search);
  while (at !== -1) {
    found.push(at);
    at = text.indexOf(search, at + 1);
  }
  return found;
}

/** The 1-based line each index starts on, counted in one pass over ascending indices. */
function lineNumbers(text: string, indices: number[]): number[] {
  const numbers: number[] = [];
  let line = 1;
  let from = 0;
  for (const at of indices) {
    for (let index = from; index < at; index++) if (text.charCodeAt(index) === 10) line++;
    numbers.push(line);
    from = at;
  }
  return numbers;
}

export function applyPatch(text: string, patch: string, options: ApplyPatchOptions): ApplyPatchResult {
  const { maxInputBytes } = options;
  if (Buffer.byteLength(text, "utf8") > maxInputBytes || Buffer.byteLength(patch, "utf8") > maxInputBytes) {
    return refused("EDIT_BLOCK_MALFORMED", null, null);
  }
  const parsed = parsePatch(patch);
  if (!Array.isArray(parsed)) return refused("EDIT_BLOCK_MALFORMED", parsed.section, null);

  const appended = text.length > 0 && !text.endsWith("\n");
  let current = appended ? `${text}\n` : text;
  for (const [index, section] of parsed.entries()) {
    const found = occurrences(current, section.search);
    if (found.length === 0) return refused("EDIT_SECTION_ABSENT", index + 1, null);
    if (found.length > 1) return refused("EDIT_SECTION_AMBIGUOUS", index + 1, lineNumbers(current, found));
    const at = found[0]!;
    current = current.slice(0, at) + section.replace + current.slice(at + section.search.length);
  }
  if (appended && current.endsWith("\n")) current = current.slice(0, -1);
  return { applied: true, text: current, code: null, section: null, lines: null };
}
