/** Whether an extraction generated the declaration's name, so the author never wrote it. */
export function isGeneratedDeclaration(manifest: { metadata?: unknown }): boolean {
  const origin = (manifest.metadata as { xTeloOrigin?: { named?: true } } | undefined)?.xTeloOrigin;
  return origin !== undefined && origin.named !== true;
}

/** A declaration as a message names it: its name, or "the inline <Kind>" when the name is generated. */
export function shownDeclaration(kind: string, name: string, manifest: { metadata?: unknown }): string {
  return isGeneratedDeclaration(manifest) ? `the inline ${kind}` : name;
}
