import { buildRename, prepareRename, type RenameResult } from "@telorun/ide-support";
import * as path from "path";
import * as vscode from "vscode";
import type { TeloAnalysisCache } from "./analysis-cache.js";

/** A module's files are local paths (or `file://` URLs); a registry import has
 *  no local buffer, and a rename never reaches one — the refusals stop at the
 *  import boundary — so an unmappable source is a defect, not a case to skip. */
function toUri(source: string): vscode.Uri | undefined {
  if (source.startsWith("file://")) return vscode.Uri.parse(source);
  if (path.isAbsolute(source)) return vscode.Uri.file(source);
  return undefined;
}

function toRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

/**
 * F2 over Telo manifests.
 *
 * **Every refusal is raised as an Error, never returned as "no edits".** VS Code
 * shows a thrown message in the rename box, and that is the whole point: a
 * refusal here means the name has too many references (an exported instance is
 * read by consumers this workspace may not contain), which is the opposite of
 * what an empty result communicates. Returning `undefined` would read as "this
 * name is not referenced anywhere".
 *
 * `prepareRename` is implemented so the box opens pre-filled with the identifier
 * alone — not the whole `!ref Alias.name` scalar or the surrounding CEL string —
 * and so a position that cannot be renamed says why *before* the author types a
 * new name rather than after.
 */
export class TeloRenameProvider implements vscode.RenameProvider {
  constructor(private readonly cache: TeloAnalysisCache) {}

  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): { range: vscode.Range; placeholder: string } {
    const graph = this.graphFor(document);
    const text = document.getText();
    const docs = this.cache.docsFor(document.uri.fsPath, text);
    const prepared = prepareRename(
      text,
      position.line,
      position.character,
      graph,
      document.uri.fsPath,
      docs,
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    return { range: toRange(prepared.symbol.range), placeholder: prepared.symbol.name };
  }

  provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): vscode.WorkspaceEdit {
    const graph = this.graphFor(document);
    const text = document.getText();
    const docs = this.cache.docsFor(document.uri.fsPath, text);
    const result: RenameResult = buildRename(
      text,
      position.line,
      position.character,
      newName,
      graph,
      document.uri.fsPath,
      docs,
    );
    if (!result.ok) throw new Error(result.reason);

    const edit = new vscode.WorkspaceEdit();
    for (const file of result.files) {
      const uri = toUri(file.uri);
      if (!uri) {
        throw new Error(`Cannot apply a rename to '${file.uri}' — it is not a local file.`);
      }
      for (const e of file.edits) edit.replace(uri, toRange(e.range), e.newText);
    }
    return edit;
  }

  /** The analysis a rename is computed against. Absent means the file has not
   *  been analyzed (or failed to load), where a rename would silently miss every
   *  reference outside the open buffer — so it refuses rather than half-applying. */
  private graphFor(document: vscode.TextDocument) {
    if (document.languageId !== "telo" && document.languageId !== "yaml") {
      throw new Error("Not a Telo manifest.");
    }
    const graph = this.cache.graphFor(document.uri.fsPath);
    if (!graph) {
      throw new Error(
        "This manifest has not been analyzed yet — a rename needs the module's other files to " +
          "find every reference. Save the file and try again.",
      );
    }
    return graph;
  }
}
