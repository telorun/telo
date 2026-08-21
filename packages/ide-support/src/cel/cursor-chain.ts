/**
 * The dotted chain the cursor is in the middle of typing.
 *
 * Deliberately TEXTUAL, and only for completion. `chainAt` (over the parsed
 * CEL AST) is what hover and go-to-declaration use, because there the
 * expression is complete and the cursor sits on a specific identifier whose
 * span matters. Completion fires on text that frequently does not parse —
 * `req.` is not an expression — so a parse-first approach would go silent
 * exactly while the user is asking for help. An open segment recovers to its
 * longest parseable PREFIX, which by definition drops the token being typed.
 */
import type { CelSegment } from "@telorun/analyzer";

export interface CelCursorChain {
  /** Identifiers resolved before the token under the cursor (`req.query.` → `["req","query"]`). */
  prefix: string[];
  /** The partial identifier being typed, possibly empty. */
  token: string;
  /** True when the cursor follows a `.` — a member position, where only the
   *  prefix's members are offered and functions are not. */
  member: boolean;
}

/** Where `segment.source` starts in document offsets. The segment range spans
 *  the delimiters (`${{ … }}`) and any trimmed whitespace, so the body has to be
 *  located inside it rather than assumed to start at `range[0]`. */
function bodyStart(text: string, segment: CelSegment): number {
  const span = text.slice(segment.range[0], segment.range[1]);
  const at = span.indexOf(segment.source);
  return at < 0 ? segment.range[0] : segment.range[0] + at;
}

const TRAILING_CHAIN = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.?$/;

/**
 * Split the text before the cursor into a resolved prefix and a partial token.
 *
 * Returns undefined when the cursor does not follow an identifier-shaped run —
 * after an operator, inside a string literal's content, at the start of an
 * empty body — where the caller offers the root scope instead of a member list.
 */
export function celCursorChain(
  text: string,
  segment: CelSegment,
  offset: number,
): CelCursorChain | undefined {
  const start = bodyStart(text, segment);
  const index = Math.max(0, Math.min(offset - start, segment.source.length));
  const before = segment.source.slice(0, index);
  const match = TRAILING_CHAIN.exec(before);
  if (!match) return undefined;
  const run = match[0];
  if (run.endsWith(".")) {
    return { prefix: run.slice(0, -1).split("."), token: "", member: true };
  }
  const parts = run.split(".");
  return { prefix: parts.slice(0, -1), token: parts[parts.length - 1], member: parts.length > 1 };
}
