import { buildHover } from "@telorun/ide-support";
import * as vscode from "vscode";
import type { TeloAnalysisCache } from "./analysis-cache.js";

export class TeloHoverProvider implements vscode.HoverProvider {
  constructor(private readonly cache: TeloAnalysisCache) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (document.languageId !== "telo" && document.languageId !== "yaml") return undefined;
    const filePath = document.uri.fsPath;
    const text = document.getText();
    const docs = this.cache.docsFor(filePath, text);
    const result = buildHover(text, position.line, position.character, this.cache.registryFor(filePath), docs);
    if (!result) return undefined;

    const contents = new vscode.MarkdownString(result.contents);
    const range = result.range
      ? new vscode.Range(
          result.range.start.line,
          result.range.start.character,
          result.range.end.line,
          result.range.end.character,
        )
      : undefined;
    return new vscode.Hover(contents, range);
  }
}
