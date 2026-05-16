import { buildCompletions, type CompletionResult } from "@telorun/ide-support";
import type { AnalysisRegistry } from "@telorun/analyzer";
import * as path from "path";
import * as vscode from "vscode";
import { VsCodeIdeAdapter } from "./ide-adapter.js";

const KIND_MAP: Record<CompletionResult["kind"], vscode.CompletionItemKind> = {
  class: vscode.CompletionItemKind.Class,
  enumMember: vscode.CompletionItemKind.EnumMember,
  property: vscode.CompletionItemKind.Property,
  folder: vscode.CompletionItemKind.Folder,
  module: vscode.CompletionItemKind.Module,
  value: vscode.CompletionItemKind.Value,
};

function toItem(r: CompletionResult, line: number, cursorChar: number): vscode.CompletionItem {
  const item = new vscode.CompletionItem(r.label, KIND_MAP[r.kind]);
  if (r.detail) item.detail = r.detail;
  if (r.documentation) item.documentation = r.documentation;
  if (r.insertText !== undefined) {
    item.insertText = r.snippet ? new vscode.SnippetString(r.insertText) : r.insertText;
  }
  if (r.preselect) item.preselect = true;
  if (r.sortText) item.sortText = r.sortText;
  if (r.filterText) item.filterText = r.filterText;
  if (r.replaceFromColumn !== undefined) {
    item.range = new vscode.Range(line, r.replaceFromColumn, line, cursorChar);
  }
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

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (document.languageId !== "telo" && document.languageId !== "yaml") return undefined;
    const registry = this.registries.get(document.uri.fsPath);
    const manifestDirUri = vscode.Uri.file(path.dirname(document.uri.fsPath));
    const adapter = new VsCodeIdeAdapter(manifestDirUri);
    const results = await buildCompletions(
      document.getText(),
      position.line,
      position.character,
      registry,
      adapter,
    );
    return results.map((r) => toItem(r, position.line, position.character));
  }
}
