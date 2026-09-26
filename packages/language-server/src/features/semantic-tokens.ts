import { buildSemanticTokens, SEMANTIC_TOKEN_LEGEND } from "@telorun/ide-support";
import { SemanticTokensBuilder, type SemanticTokensLegend } from "vscode-languageserver/browser";
import { sourceOfUri } from "../document-uri.js";
import type { FeatureContext } from "./context.js";

/** ide-support's legend, advertised once at initialize: a token's type is its
 *  index here, and new types are only ever appended. */
export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_LEGEND],
  tokenModifiers: [],
};

export function registerSemanticTokens({ connection, documents, session }: FeatureContext): void {
  connection.languages.semanticTokens.on((params) => {
    const document = documents.get(params.textDocument.uri);
    const builder = new SemanticTokensBuilder();
    if (!document) return builder.build();
    const analysis = session.documentAnalysis(sourceOfUri(params.textDocument.uri));
    const text = document.getText();
    const tokens = buildSemanticTokens(
      text,
      analysis.registry,
      analysis.docsFor(text),
      analysis.analysis,
    );
    // The wire form is delta-encoded, so tokens go out in document order.
    tokens.sort((a, b) => a.line - b.line || a.character - b.character);
    for (const t of tokens) {
      builder.push(t.line, t.character, t.length, SEMANTIC_TOKEN_LEGEND.indexOf(t.type), 0);
    }
    return builder.build();
  });
}
