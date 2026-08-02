import type { AstScalar } from "@telorun/analyzer";

/** An `<Alias>.<Name>` scalar split at its first dot — the grammar `kind:`,
 *  `extends:`, `x-telo-ref` and `!ref` all share — plus which half the cursor
 *  sits on, so the alias navigates to its import and the suffix to the thing
 *  the alias qualifies. */
export interface AliasQualifiedValue {
  /** Undefined for an unqualified value (a bare local name). */
  alias?: string;
  /** Everything after the first dot, or the whole value when unqualified. */
  name: string;
  /** True when the cursor sits on the alias half (dot inclusive). */
  onAlias: boolean;
}

/** Split the scalar at `node` around the cursor at `offset` (a document offset).
 *
 *  The parsed value is authoritative where there is one — the source range spans
 *  the whole scalar token, so a quoted `x-telo-ref: "Alias.Kind"` would otherwise
 *  carry its quotes into the alias and miss every lookup. A `!ref` / `!cel`
 *  scalar resolves to a tagged sentinel rather than a string, so those fall back
 *  to the raw slice. The range is still what locates the value inside the token,
 *  which is what the cursor is hit-tested against. */
export function splitAliasQualified(
  text: string,
  node: AstScalar,
  offset: number,
): AliasQualifiedValue | undefined {
  const raw = text.slice(node.range[0], node.range[1]);
  const value = typeof node.value === "string" ? node.value : raw.trim();
  if (!value) return undefined;
  const at = raw.indexOf(value);
  const start = node.range[0] + (at >= 0 ? at : 0);

  const dot = value.indexOf(".");
  if (dot === -1) return { name: value, onAlias: false };
  return {
    alias: value.slice(0, dot),
    name: value.slice(dot + 1),
    onAlias: offset <= start + dot,
  };
}
