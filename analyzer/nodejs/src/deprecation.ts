/**
 * `metadata.deprecated` — the annotation's single reader.
 *
 * Structural validity belongs to `validate-module-metadata.ts` (the strict half,
 * the `ref-slot.ts` split). This side is deliberately lenient: it reads a
 * well-formed block and treats everything else as absent, so a malformed
 * declaration in a published dependency never becomes a warning at a consumer's
 * use site. The consumer can fix neither one, and reporting the second blames
 * the wrong author.
 */

/** A deprecation as declared: why, and optionally what to use instead. */
export interface Deprecation {
  /** What a consumer reads to know what to do instead. Always non-empty. */
  reason: string;
  /** Alias-qualified kind (kind docs) or module ref (module docs), **as written
   *  in the declaring file's own scope** — `Self.Thing` means nothing to a
   *  consumer, so a use site resolves it before quoting it. */
  replacedBy?: string;
}

export function readDeprecation(metadata: unknown): Deprecation | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const block = (metadata as Record<string, unknown>).deprecated;
  if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;

  const { reason, replacedBy } = block as Record<string, unknown>;
  if (typeof reason !== "string" || reason.trim() === "") return undefined;

  return {
    reason: reason.trim(),
    ...(typeof replacedBy === "string" && replacedBy.trim() !== ""
      ? { replacedBy: replacedBy.trim() }
      : {}),
  };
}
