/** Rendering a diagnostic's repair back into YAML source.
 *
 *  A `fix.replacement` is a bare VALUE — a CEL expression, a kind name — while
 *  the span it replaces is the value node as written, which includes the
 *  scalar's quotes. (The YAML tag sits outside that span, so `!cel` survives a
 *  replacement without anything doing it on purpose.) Writing the bare value
 *  into a quoted span therefore strips the quotes, and a CEL expression is
 *  exactly the kind of text that stops being one scalar once unquoted: a
 *  `: ` inside it starts a mapping, a trailing `#` starts a comment, a leading
 *  `%` or `&` is an indicator.
 *
 *  So the replacement is re-quoted in the style the author used, and promoted
 *  to double quotes when a plain scalar could not survive the round-trip. This
 *  lives here rather than in one editor because both surfaces — the VS Code
 *  extension's quick fix and the Tauri editor's — apply the same repair to the
 *  same source, and the two must not disagree about how a value is written. */

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

/** Quote style of the source text a fix is replacing. */
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
 *  value. `DiagnosticFix` promises a repair that can be applied without review,
 *  so the only honest answer for these is no repair. */
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
