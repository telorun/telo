/**
 * Whether a document is the entry's own to report: it carries no
 * `metadata.module` stamp, or its stamp names a module whose module document
 * is in the analysed set (`rootModules`). A dependency's documents are stamped
 * with a module whose document the flattened set drops.
 */
export function isEntryOwned(m: { metadata?: unknown }, rootModules: ReadonlySet<string>): boolean {
  const module = (m.metadata as { module?: unknown } | undefined)?.module;
  return typeof module !== "string" || rootModules.has(module);
}
