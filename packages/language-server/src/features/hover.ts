import { buildHover } from "@telorun/ide-support";
import { MarkupKind } from "vscode-languageserver/browser";
import { sourceOfUri } from "../document-uri.js";
import type { FeatureContext } from "./context.js";

export function registerHover({ connection, documents, session }: FeatureContext): void {
  connection.onHover((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const analysis = session.documentAnalysis(sourceOfUri(params.textDocument.uri));
    const text = document.getText();
    const result = buildHover(
      text,
      params.position.line,
      params.position.character,
      analysis.registry,
      analysis.docsFor(text),
      analysis.analysis,
    );
    if (!result) return null;
    return {
      contents: { kind: MarkupKind.Markdown, value: result.contents },
      ...(result.range ? { range: result.range } : {}),
    };
  });
}
