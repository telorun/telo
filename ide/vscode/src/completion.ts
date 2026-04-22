import { buildCompletions, type CompletionResult } from "@telorun/ide-support";
import type { AnalysisRegistry } from "@telorun/analyzer";
import * as vscode from "vscode";

const KIND_MAP: Record<CompletionResult["kind"], vscode.CompletionItemKind> = {
  class: vscode.CompletionItemKind.Class,
  enumMember: vscode.CompletionItemKind.EnumMember,
  property: vscode.CompletionItemKind.Property,
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
  return item;
}

export class TeloCompletionProvider implements vscode.CompletionItemProvider {
  private readonly registries = new Map<string, AnalysisRegistry>();

  updateRegistry(filePath: string, registry: AnalysisRegistry): void {
    this.registries.set(filePath, registry);
  }

  deleteRegistry(filePath: string): void {
    this.registries.delete(filePath);
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    if (document.languageId !== "yaml") return undefined;
    const registry = this.registries.get(document.uri.fsPath);
    return buildCompletions(
      document.getText(),
      position.line,
      position.character,
      registry,
    ).map(toItem);
  }
}
