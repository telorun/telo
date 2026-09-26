import { buildCompletions, type CompletionResult } from "@telorun/ide-support";
import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem,
} from "vscode-languageserver/browser";
import { sourceOfUri } from "../document-uri.js";
import { HostIdeAdapter } from "../host-ide-adapter.js";
import type { FeatureContext } from "./context.js";

/** Characters that open completion. `-` opens a new list entry in
 *  `telo-workspace.yaml` and means nothing in a manifest. */
export const COMPLETION_TRIGGERS = [" ", ":", "/", "@", "!", "-"];
const MARKER_ONLY_TRIGGERS = new Set(["-"]);

const KIND: Record<CompletionResult["kind"], CompletionItemKind> = {
  class: CompletionItemKind.Class,
  enumMember: CompletionItemKind.EnumMember,
  property: CompletionItemKind.Property,
  folder: CompletionItemKind.Folder,
  file: CompletionItemKind.File,
  module: CompletionItemKind.Module,
  value: CompletionItemKind.Value,
  keyword: CompletionItemKind.Keyword,
};

/** The command a client runs to reopen completion once an item is accepted —
 *  VS Code's and Monaco's shared id. */
const RETRIGGER_COMMAND = "editor.action.triggerSuggest";

export function toCompletionItem(r: CompletionResult): CompletionItem {
  const newText = r.insertText ?? r.label;
  return {
    label: r.label,
    kind: KIND[r.kind],
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.documentation ? { documentation: r.documentation } : {}),
    ...(r.snippet ? { insertTextFormat: InsertTextFormat.Snippet } : {}),
    ...(r.replaceRange
      ? { textEdit: { range: r.replaceRange, newText } }
      : r.insertText !== undefined
        ? { insertText: r.insertText }
        : {}),
    ...(r.preselect ? { preselect: true } : {}),
    ...(r.sortText ? { sortText: r.sortText } : {}),
    ...(r.filterText ? { filterText: r.filterText } : {}),
    ...(r.retrigger ? { command: { title: "", command: RETRIGGER_COMMAND } } : {}),
  };
}

export function registerCompletion({ connection, documents, session, markers, host }: FeatureContext): void {
  connection.onCompletion(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const source = sourceOfUri(params.textDocument.uri);
    const text = document.getText();
    const { line, character } = params.position;

    if (markers.isMarker(source)) {
      return (await markers.completions(source, text, params.position)).map(toCompletionItem);
    }
    const trigger = params.context?.triggerCharacter;
    if (trigger !== undefined && MARKER_ONLY_TRIGGERS.has(trigger)) return null;

    const analysis = session.documentAnalysis(source);
    const results = await buildCompletions(
      text,
      line,
      character,
      analysis.registry,
      new HostIdeAdapter(host, source, analysis.moduleRoot),
      analysis.docsFor(text),
      analysis.analysis,
    );
    return results.map(toCompletionItem);
  });
}
