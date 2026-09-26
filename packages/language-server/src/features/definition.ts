import { buildDefinition } from "@telorun/ide-support";
import { isLocalPath, sourceOfUri, uriOfSource } from "../document-uri.js";
import type { FeatureContext } from "./context.js";

export function registerDefinition({ connection, documents, session }: FeatureContext): void {
  connection.onDefinition((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const source = sourceOfUri(params.textDocument.uri);
    const analysis = session.documentAnalysis(source);
    if (!analysis.graph) return null;
    const text = document.getText();
    const result = buildDefinition(
      text,
      params.position.line,
      params.position.character,
      analysis.graph,
      source,
      analysis.docsFor(text),
      analysis.analysis,
    );
    // A target inside a registry import has no buffer an editor can open.
    if (!result || !isLocalPath(result.uri)) return null;
    return { uri: uriOfSource(result.uri), range: result.range };
  });
}
