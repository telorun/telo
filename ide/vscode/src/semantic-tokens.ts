import { buildSemanticTokens, SEMANTIC_TOKEN_LEGEND } from "@telorun/ide-support";
import * as vscode from "vscode";
import type { TeloAnalysisCache } from "./analysis-cache.js";

export const TELO_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend([...SEMANTIC_TOKEN_LEGEND]);

export class TeloSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this.changed.event;

  constructor(private readonly cache: TeloAnalysisCache) {}

  /** Tell VS Code to re-request tokens — called after an analysis pass so a
   *  now-resolved kind lights up without waiting for the next edit. */
  refresh(): void {
    this.changed.fire();
  }

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens | undefined {
    if (document.languageId !== "telo" && document.languageId !== "yaml") return undefined;
    const filePath = document.uri.fsPath;
    const text = document.getText();
    const docs = this.cache.docsFor(filePath, text);
    const tokens = buildSemanticTokens(text, this.cache.registryFor(filePath), docs);

    const builder = new vscode.SemanticTokensBuilder(TELO_SEMANTIC_LEGEND);
    for (const t of tokens) {
      builder.push(t.line, t.character, t.length, SEMANTIC_TOKEN_LEGEND.indexOf(t.type), 0);
    }
    return builder.build();
  }
}
