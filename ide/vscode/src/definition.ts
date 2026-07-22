import { buildDefinition } from "@telorun/ide-support";
import * as path from "path";
import * as vscode from "vscode";
import type { TeloAnalysisCache } from "./analysis-cache.js";

/** Turn a target's canonical source into a URI VS Code can open. Local targets
 *  are `file://` paths or absolute paths; a registry import resolves to an
 *  http/oci URL that has no local buffer to jump to, so those are skipped. */
function toUri(source: string): vscode.Uri | undefined {
  if (source.startsWith("file://")) return vscode.Uri.parse(source);
  if (path.isAbsolute(source)) return vscode.Uri.file(source);
  return undefined;
}

export class TeloDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly cache: TeloAnalysisCache) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | undefined {
    if (document.languageId !== "telo" && document.languageId !== "yaml") return undefined;
    const filePath = document.uri.fsPath;
    const graph = this.cache.graphFor(filePath);
    if (!graph) return undefined;

    const text = document.getText();
    const docs = this.cache.docsFor(filePath, text);
    const result = buildDefinition(text, position.line, position.character, graph, filePath, docs);
    if (!result) return undefined;

    const uri = toUri(result.uri);
    if (!uri) return undefined;
    const range = new vscode.Range(
      result.range.start.line,
      result.range.start.character,
      result.range.end.line,
      result.range.end.character,
    );
    return new vscode.Location(uri, range);
  }
}
