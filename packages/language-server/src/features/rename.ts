import { buildRename, prepareRename } from "@telorun/ide-support";
import {
  LSPErrorCodes,
  ResponseError,
  type TextEdit,
  type WorkspaceEdit,
} from "vscode-languageserver/browser";
import { isLocalPath, sourceOfUri, uriOfSource } from "../document-uri.js";
import type { FeatureContext } from "./context.js";

/**
 * Rename over a module's files.
 *
 * **Every refusal is an error response carrying its reason, never an empty
 * edit.** A refusal here means the name has too MANY references (an exported
 * instance is read by consumers this workspace may not contain), the opposite
 * of what "no edits" communicates. `prepareRename` answers with the identifier
 * alone, so the rename box opens on the name rather than the whole `!ref` scalar
 * or CEL string, and a position that cannot be renamed says why before the
 * author types a new name.
 */
export function registerRename({ connection, documents, session }: FeatureContext): void {
  const graphFor = (uri: string) => {
    const analysis = session.documentAnalysis(sourceOfUri(uri));
    if (!analysis.graph) {
      throw new ResponseError(
        LSPErrorCodes.RequestFailed,
        "This manifest has not been analyzed yet — a rename needs the module's other files to " +
          "find every reference. Save the file and try again.",
      );
    }
    return { ...analysis, graph: analysis.graph };
  };

  connection.onPrepareRename((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const analysis = graphFor(params.textDocument.uri);
    const text = document.getText();
    const prepared = prepareRename(
      text,
      params.position.line,
      params.position.character,
      analysis.graph,
      sourceOfUri(params.textDocument.uri),
      analysis.docsFor(text),
    );
    if (!prepared.ok) throw new ResponseError(LSPErrorCodes.RequestFailed, prepared.reason);
    return { range: prepared.symbol.range, placeholder: prepared.symbol.name };
  });

  connection.onRenameRequest((params): WorkspaceEdit | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const analysis = graphFor(params.textDocument.uri);
    const text = document.getText();
    const result = buildRename(
      text,
      params.position.line,
      params.position.character,
      params.newName,
      analysis.graph,
      sourceOfUri(params.textDocument.uri),
      analysis.docsFor(text),
      analysis.analysis,
    );
    if (!result.ok) throw new ResponseError(LSPErrorCodes.RequestFailed, result.reason);

    const changes: Record<string, TextEdit[]> = {};
    for (const file of result.files) {
      // The refusals stop at the import boundary, so a file outside the
      // workspace here is a defect, not a case to skip.
      if (!isLocalPath(file.uri)) {
        throw new ResponseError(
          LSPErrorCodes.RequestFailed,
          `Cannot apply a rename to '${file.uri}' — it is not a local file.`,
        );
      }
      changes[uriOfSource(file.uri)] = file.edits.map((e) => ({ range: e.range, newText: e.newText }));
    }
    return { changes };
  });
}
