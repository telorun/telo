import type { OnMount } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";
import { buildCompletions } from "@telorun/ide-support";
import { pathDirname } from "../../../loader/paths";
import { EditorIdeAdapter } from "./ide-adapter";
import { registryRef, settingsRef, threadedDocs, workspaceRef } from "./provider-state";

type Monaco = Parameters<OnMount>[1];

export function registerYamlCompletions(monaco: Monaco): void {
  const kindMap = {
    class: monaco.languages.CompletionItemKind.Class,
    enumMember: monaco.languages.CompletionItemKind.EnumMember,
    property: monaco.languages.CompletionItemKind.Property,
    folder: monaco.languages.CompletionItemKind.Folder,
    module: monaco.languages.CompletionItemKind.Module,
    value: monaco.languages.CompletionItemKind.Value,
  } as const;

  monaco.languages.registerCompletionItemProvider("yaml", {
    triggerCharacters: [" ", ":", "/", "@"],
    async provideCompletionItems(model: editor.ITextModel, position: Position) {
      const word = model.getWordUntilPosition(position);
      const defaultRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const workspace = workspaceRef.current;
      const settings = settingsRef.current;
      const manifestDir = pathDirname(model.uri.path);
      const adapter =
        workspace && settings
          ? new EditorIdeAdapter(manifestDir, workspace, settings.hubUrl)
          : undefined;

      const text = model.getValue();
      const results = await buildCompletions(
        text,
        position.lineNumber - 1,
        position.column - 1,
        registryRef.current,
        adapter,
        threadedDocs(text),
      );
      return {
        suggestions: results.map((r) => {
          // Monaco is 1-based; `replaceRange` is the 0-based full span of the
          // existing node, so a pick overwrites any suffix after the cursor too.
          const range = r.replaceRange
            ? {
                startLineNumber: r.replaceRange.start.line + 1,
                startColumn: r.replaceRange.start.character + 1,
                endLineNumber: r.replaceRange.end.line + 1,
                endColumn: r.replaceRange.end.character + 1,
              }
            : defaultRange;
          return {
            label: r.label,
            kind: kindMap[r.kind],
            detail: r.detail,
            documentation: r.documentation,
            insertText: r.insertText ?? r.label,
            insertTextRules: r.snippet
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : monaco.languages.CompletionItemInsertTextRule.None,
            sortText: r.sortText,
            filterText: r.filterText,
            preselect: r.preselect,
            range,
          };
        }),
      };
    },
  });
}
