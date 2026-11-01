import { buildFormatting } from "@telorun/ide-support";
import type { FeatureContext } from "./context.js";

/** Format-on-save and "Format Document": the analyzer's layout engine over the open text. */
export function registerFormatting({ connection, documents }: FeatureContext): void {
  connection.onDocumentFormatting((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    return buildFormatting(document.getText()).map((edit) => ({
      range: { start: document.positionAt(edit.start), end: document.positionAt(edit.end) },
      newText: edit.newText,
    }));
  });
}
