/**
 * Is this manifest, in a consumer's flattened analysis, a DEPENDENCY's code?
 *
 * Two stamps say so, and they are kept apart on purpose:
 *
 *  - `forwardedExport` — an imported library's exported instance, stamped by
 *    flatten. It is what the consumer can reach, so the passes that count
 *    EXPORTS (`validate-exports`, the `resources.<Alias>.<name>` index, zone
 *    export seeding) read it and nothing else.
 *  - `forwardedInternal` — a declaration inline extraction pulled OUT of a
 *    forwarded manifest (a step target, an inline handler), stamped by
 *    `normalizeInlineResources`. It is the library's code, written in the
 *    library's names, and not something the library exports; counting it as an
 *    export would let a consumer's `!ref Alias.<generated name>` pass a check the
 *    kernel refuses.
 *
 * Every pass that asks "is this the consumer's to check, or to resolve its own
 * names against?" asks THIS, so a dependency's extraction is treated exactly as
 * the manifest it came out of.
 *
 * Browser-safe.
 */
export function isForwardedDeclaration(manifest: unknown): boolean {
  const meta = (manifest as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  return meta?.forwardedExport === true || meta?.forwardedInternal === true;
}

/** Only an exported instance — for the passes that count what a library exports. */
export function isForwardedExport(manifest: unknown): boolean {
  const meta = (manifest as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  return meta?.forwardedExport === true;
}
