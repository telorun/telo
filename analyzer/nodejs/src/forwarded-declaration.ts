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
 *    `normalizeInlineResources`; or a resource a forwarded manifest's expressions
 *    call through `Self` (a function an exported function calls), stamped by
 *    flatten so what the call reaches can be derived. It is the library's code,
 *    written in the library's names, and not something the library exports;
 *    counting it as an export would let a consumer's `!ref Alias.<name>` pass a
 *    check the kernel refuses.
 *  - `forwardedShape` — a named shape a forwarded kind's contract or signature
 *    names (`outputType: !ref Money`), stamped by flatten so the reference
 *    resolves in its declaring module. Not exported and not reachable by a
 *    consumer's `!ref`; present only so the shape a comparison or a typing needs
 *    is in the set.
 *
 * Every pass that asks "is this the consumer's to check, or to resolve its own
 * names against?" asks THIS, so a dependency's extraction is treated exactly as
 * the manifest it came out of.
 *
 * Browser-safe.
 */
export function isForwardedDeclaration(manifest: unknown): boolean {
  const meta = (manifest as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  return (
    meta?.forwardedExport === true ||
    meta?.forwardedInternal === true ||
    meta?.forwardedShape === true
  );
}

/** Only a shape forwarded for a dependency's contract — plumbing for the passes
 *  that resolve one, never a declaration anything draws or reaches. */
export function isForwardedShape(manifest: unknown): boolean {
  const meta = (manifest as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  return meta?.forwardedShape === true;
}

/** Only an exported instance — for the passes that count what a library exports. */
export function isForwardedExport(manifest: unknown): boolean {
  const meta = (manifest as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  return meta?.forwardedExport === true;
}
