import { buildCompletions, type CompletionResult } from "@telorun/ide-support";
import type { AnalysisRegistry, AstDocument } from "@telorun/analyzer";
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
  private readonly registries = new Map<string, AnalysisRegistry>();
  /** Per-file parsed AST from the last analysis pass, with the text it was
   *  parsed from. Completion reuses it only when the buffer still matches, so a
   *  stale entry falls back to a local parse. */
  private readonly docs = new Map<string, { text: string; docs: AstDocument[] }>();

  updateRegistry(
    filePath: string,
    registry: AnalysisRegistry,
    parsed?: { text: string; docs: AstDocument[] },
  ): void {
    this.registries.set(filePath, registry);
    if (parsed) this.docs.set(filePath, parsed);
    else this.docs.delete(filePath);
  }

  deleteRegistry(filePath: string): void {
    this.registries.delete(filePath);
    this.docs.delete(filePath);
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (document.languageId !== "telo" && document.languageId !== "yaml") return undefined;
    const registry = this.registries.get(document.uri.fsPath);
    const text = document.getText();
    const parsed = this.docs.get(document.uri.fsPath);
    const threaded = parsed && parsed.text === text ? parsed.docs : undefined;
    const manifestDirUri = vscode.Uri.file(path.dirname(document.uri.fsPath));
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
