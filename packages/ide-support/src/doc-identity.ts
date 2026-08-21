/**
 * A document's `kind` + `metadata.name` — the pair that names the resource an
 * analyzed manifest set holds it under.
 *
 * Its own module because it is a document-identity primitive, not a completion
 * one: hover, semantic tokens and both declaration locators need it, and
 * reaching it through the completion entry point dragged that whole module
 * graph — CEL completion, call-input resolution, the import-source machinery —
 * into surfaces that use none of it.
 */
import type { AstDocument, AstMap } from "@telorun/analyzer";

const scalar = (node: { kind: string; value?: unknown } | undefined): string | undefined =>
  node?.kind === "scalar" && typeof node.value === "string" ? node.value : undefined;

/** Either half may be absent while the author is still writing the document. */
export function docIdentity(doc: AstDocument | undefined): { kind?: string; name?: string } {
  if (doc?.root?.kind !== "map") return {};
  let kind: string | undefined;
  let name: string | undefined;
  for (const pair of doc.root.entries) {
    const key = scalar(pair.key);
    if (key === "kind") kind = scalar(pair.value);
    else if (key === "metadata" && pair.value?.kind === "map") {
      const meta = pair.value as AstMap;
      const nameEntry = meta.entries.find((e) => scalar(e.key) === "name");
      name = scalar(nameEntry?.value);
    }
  }
  return { kind, name };
}
