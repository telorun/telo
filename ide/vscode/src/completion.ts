import { buildCompletions, type CompletionResult } from "@telorun/ide-support";
import * as path from "path";
import * as vscode from "vscode";
import type { TeloAnalysisCache } from "./analysis-cache.js";
import { VsCodeIdeAdapter } from "./ide-adapter.js";

const KIND_MAP: Record<CompletionResult["kind"], vscode.CompletionItemKind> = {
  class: vscode.CompletionItemKind.Class,
  enumMember: vscode.CompletionItemKind.EnumMember,
  property: vscode.CompletionItemKind.Property,
  folder: vscode.CompletionItemKind.Folder,
  module: vscode.CompletionItemKind.Module,
  value: vscode.CompletionItemKind.Value,
};

function toItem(r: CompletionResult): vscode.CompletionItem {
  const item = new vscode.CompletionItem(r.label, KIND_MAP[r.kind]);
  if (r.detail) item.detail = r.detail;
  if (r.documentation) item.documentation = r.documentation;
  if (r.insertText !== undefined) {
    item.insertText = r.snippet ? new vscode.SnippetString(r.insertText) : r.insertText;
  }
  if (r.preselect) item.preselect = true;
  if (r.sortText) item.sortText = r.sortText;
  if (r.filterText) item.filterText = r.filterText;
  if (r.replaceRange) {
    const { start, end } = r.replaceRange;
    item.range = new vscode.Range(start.line, start.character, end.line, end.character);
  }
  return item;
}

export class TeloCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly cache: TeloAnalysisCache) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (document.languageId !== "telo" && document.languageId !== "yaml") return undefined;
    const filePath = document.uri.fsPath;
    const registry = this.cache.registryFor(filePath);
    const text = document.getText();
    const threaded = this.cache.docsFor(filePath, text);
    const manifestDirUri = vscode.Uri.file(path.dirname(filePath));
    const adapter = new VsCodeIdeAdapter(manifestDirUri);
    const results = await buildCompletions(
      text,
      position.line,
      position.character,
      registry,
      adapter,
      threaded,
    );
    return results.map((r) => toItem(r));
  }
}
