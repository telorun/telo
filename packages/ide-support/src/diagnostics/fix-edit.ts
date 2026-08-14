/** Rendering a diagnostic's repair back into YAML source.
 *
 *  A `fix.replacement` is a bare VALUE — a CEL expression, a kind name — while
 *  the span it replaces is the value node as written, which includes the
 *  scalar's quotes. (The YAML tag sits outside that span, so `!cel` survives a
 *  replacement without anything doing it on purpose.) Writing the bare value
 *  into a quoted span therefore strips the quotes, and a CEL expression is
 *  exactly the kind of text that stops being one scalar once unquoted.
 *
 *  **The rule itself lives in `@telorun/analyzer`** (`yaml-source-edit.ts`),
 *  not here. It started here because both editors' quick fixes had to agree
 *  about how a value is written; `telo migrate` then became a third writer of
 *  the same files, and the analyzer is below all three. Re-exported rather than
 *  moved outright so a host keeps importing its repair rendering from the
 *  package that owns the rest of its diagnostic presentation. */

export {
  applyTextEdits,
  isPlainSafe,
  quoteStyleOf,
  renderFixReplacement,
  type QuoteStyle,
  type TextEdit,
} from "@telorun/analyzer";
