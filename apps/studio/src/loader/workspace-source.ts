import type { ManifestSource } from "@telorun/analyzer";
import type { ModuleDocument } from "../model";
import { serializeModuleDocument } from "../yaml-document";
import { normalizePath } from "./paths";

/** A `ManifestSource` backed by the editor's in-memory `documents` (the live,
 *  possibly-unsaved AST), with a fallback source for everything it doesn't hold
 *  (transitive registry/remote deps, sibling files not yet opened).
 *
 *  This is the seam that lets the editor drive the analyzer's own
 *  `Loader.loadGraph` + `flattenForAnalyzer` for analysis instead of
 *  re-implementing the flatten/identity pipeline: the analyzer re-reads each
 *  module's *current* content (reflecting edits) through this source, follows
 *  inline imports, and resolves module identity exactly as the CLI does.
 *
 *  Fidelity mirrors the editor's existing contract: a clean document serves its
 *  exact buffer text (`loaded.text`, so positions match Monaco); a dirty one
 *  serves its re-serialized current AST (content reflects the edit; positions
 *  are approximate — those diagnostics route by resource identity anyway). */
export function createWorkspaceDocumentSource(
  documents: Map<string, ModuleDocument>,
  fallback: ManifestSource,
): ManifestSource {
  const source: ManifestSource = {
    supports(url: string): boolean {
      return documents.has(normalizePath(url));
    },
    async read(url: string): Promise<{ text: string; source: string }> {
      const doc = documents.get(normalizePath(url));
      if (!doc) throw new Error(`workspace-source: no document for ${url}`);
      const text = doc.dirty
        ? serializeModuleDocument(doc.loaded.documents)
        : doc.loaded.text;
      return { text, source: doc.loaded.source };
    },
    resolveRelative(base: string, relative: string): string {
      return fallback.resolveRelative(base, relative);
    },
  };
  if (fallback.expandGlob) {
    source.expandGlob = (base, patterns) => fallback.expandGlob!(base, patterns);
  }
  if (fallback.resolveOwnerOf) {
    source.resolveOwnerOf = (fileUrl) => fallback.resolveOwnerOf!(fileUrl);
  }
  return source;
}
