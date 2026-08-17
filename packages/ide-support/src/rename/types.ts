import type { Range } from "../types.js";

/**
 * Which naming surface a rename targets. Only the value-level, module-local
 * ones are supported — see `build-rename.ts` for why each of the others is a
 * refusal rather than an omission.
 */
export type RenameSymbolKind =
  /** A resource instance's `metadata.name`. */
  | "resource"
  /** A `name:` on a step inside a step array. */
  | "step"
  /** A key of the module doc's `variables:` / `secrets:` / `ports:` block. */
  | "declaration";

/** What the cursor resolved to, and the span the host pre-fills in its rename
 *  box. `block` is set only for a `declaration`. */
export interface RenameSymbol {
  kind: RenameSymbolKind;
  name: string;
  range: Range;
  block?: "variables" | "secrets" | "ports";
}

/** One replacement. `range` is a source span in `uri`; `newText` replaces it
 *  wholesale. Spans never overlap and never cross a line, because every site is
 *  either a bare scalar value or an identifier inside one. */
export interface RenameEdit {
  range: Range;
  newText: string;
}

export interface RenameFileEdits {
  uri: string;
  edits: RenameEdit[];
}

/**
 * A refusal carries the reason, always. A rename the tool declines is a
 * decision the author has to act on — silently returning "nothing to rename"
 * would read as "this name has no references", which is the opposite of what a
 * refusal usually means here (an exported name has too many, in files this
 * workspace cannot see).
 */
export type RenamePreparation =
  | { ok: true; symbol: RenameSymbol }
  | { ok: false; reason: string };

export type RenameResult =
  | { ok: true; symbol: RenameSymbol; files: RenameFileEdits[] }
  | { ok: false; reason: string };
