/** Writing a value back into YAML SOURCE — the two primitives every in-place
 *  repair is built from, and the one place their rules are stated.
 *
 *  A repair is a byte splice over the author's own text, never
 *  `Document.toString()`: re-serializing re-folds block scalars, drops
 *  quote-style hints and reflows long strings, so a one-key edit would arrive
 *  as a whole-file diff. That leaves two questions every writer has to answer
 *  identically — how a value is re-quoted to occupy a span, and how overlapping
 *  spans are spliced — and three surfaces asking them: the editors' quick fix
 *  (`@telorun/ide-support`), `telo migrate` (the migration driver), and
 *  `telo upgrade`'s pin rewrite.
 *
 *  They live HERE, in the lowest package of the three, because they are pure
 *  string work with no Node dependency and because a copy per surface is a
 *  silent-divergence risk of exactly the kind Telo's cross-cutting primitives
 *  rule exists to prevent: two writers editing the same file from two copies of
 *  a subtle quoting rule will eventually quote one value two ways, and nothing
 *  would catch it. Same precedent as `ref-slot.ts` / `binary-slot.ts` — a rule
 *  several surfaces must agree on gets one reader. */

/** Characters that make a plain (unquoted) YAML scalar reparse as something
 *  else. `-` and `?` are indicators only when followed by a space, so they are
 *  handled by the leading-token check rather than listed here. */
const PLAIN_UNSAFE_LEAD = new Set([
  "&", "*", "!", "|", ">", "%", "@", "`", "#", "'", '"', "{", "[", "}", "]", ",",
]);

/** Whether `value` can be written as a plain scalar without changing meaning. */
export function isPlainSafe(value: string): boolean {
  if (value === "" || value.trim() !== value) return false;
  if (PLAIN_UNSAFE_LEAD.has(value[0]!)) return false;
  // `-`/`?`/`:` lead only matter when a space follows — `-x` is a scalar,
  // `- x` is a sequence entry.
  if (/^[-?:]\s/.test(value)) return false;
  // A colon-space anywhere opens a mapping; a space-hash opens a comment.
  if (value.includes(": ") || value.includes(" #")) return false;
  if (value.endsWith(":")) return false;
  return !/[\n\r]/.test(value);
}

/** Quote style of the source text a repair is replacing. */
export type QuoteStyle = "double" | "single" | "plain";

export function quoteStyleOf(source: string): QuoteStyle {
  if (source.length >= 2 && source.startsWith('"') && source.endsWith('"')) return "double";
  if (source.length >= 2 && source.startsWith("'") && source.endsWith("'")) return "single";
  return "plain";
}

/** Render `replacement` so it occupies `originalSource`'s span as the same
 *  scalar the author would have written by hand, or `undefined` when the span
 *  cannot be rewritten safely.
 *
 *  A plain original is kept plain when it can be — rewriting `Run.Sequenc` to
 *  `"Run.Sequence"` would be a correct but noisy diff on a kind name — and
 *  promoted to double quotes when the new value would not survive unquoted.
 *
 *  **A multi-line span is refused.** A block scalar's span covers its `|`/`>-`
 *  indicator AND its trailing newline, so writing a single-line scalar over it
 *  deletes the line break that ended the mapping entry and glues the next key
 *  onto the value — the document stops parsing. Re-emitting a block scalar
 *  correctly needs the node's indentation, which no consumer of this function
 *  has. A multi-line REPLACEMENT is refused for the mirror reason: its
 *  continuation lines would land at column 0, which is not a legal mapping
 *  value. A quick fix promises a repair that can be applied without review, so
 *  the only honest answer for these is no repair. */
export function renderFixReplacement(
  originalSource: string,
  replacement: string,
): string | undefined {
  if (/[\n\r]/.test(originalSource) || /[\n\r]/.test(replacement)) return undefined;
  const style = quoteStyleOf(originalSource);

  if (style === "single") {
    // A single-quoted YAML scalar escapes only the quote, by doubling it. CEL
    // string literals use single quotes constantly, so this is the common case
    // for an expression written in a single-quoted scalar.
    return `'${replacement.replaceAll("'", "''")}'`;
  }
  if (style === "double" || !isPlainSafe(replacement)) {
    return `"${replacement.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return replacement;
}

/** A splice over a source file: replace `[start, end)` with `newText`. An empty
 *  span is a pure insertion. */
export interface TextEdit {
  /** Byte offset of the first replaced character (inclusive). */
  readonly start: number;
  /** Byte offset one past the last replaced character. */
  readonly end: number;
  readonly newText: string;
}

/** Splice `edits` into `text`, right to left so earlier offsets stay valid.
 *  Callers are responsible for edits not overlapping; two splices contending
 *  for the same bytes cannot both be honoured, and this does not arbitrate. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return text;
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
  }
  return out;
}
