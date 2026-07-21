import type { OnMount } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";
import type { AnalysisRegistry } from "@telorun/analyzer";
import { buildCompletions } from "@telorun/ide-support";
import type { AppSettings, WorkspaceAdapter } from "../../../model";
import { pathDirname } from "../../../loader/paths";
import { EditorIdeAdapter } from "./ide-adapter";

type Monaco = Parameters<OnMount>[1];

/** Module-scoped single registration state. Monaco's language providers are
 *  process-wide — registering inside a component's onMount would stack a new
 *  provider on every mount. A WeakSet keyed on the monaco instance keeps one
 *  registration per runtime. */
const registered = new WeakSet<Monaco>();
const registryRef: { current: AnalysisRegistry | undefined } = { current: undefined };
const workspaceRef: { current: WorkspaceAdapter | undefined } = { current: undefined };
const settingsRef: { current: AppSettings | undefined } = { current: undefined };

/** Updates the active registry the provider consults. Called from Editor.tsx
 *  after each analysis pass. The provider reads through this ref so completion
 *  never goes stale even though registration happened once at mount. */
export function setActiveRegistry(r: AnalysisRegistry | undefined): void {
  registryRef.current = r;
}

/** Sources of side-channel data the import-source completer needs (filesystem
 *  reads + the configured hub URL). Pushed in from Editor.tsx the same way
 *  as the analyzer registry. */
export function setActiveWorkspaceAdapter(a: WorkspaceAdapter | undefined): void {
  workspaceRef.current = a;
}

export function setActiveSettings(s: AppSettings | undefined): void {
  settingsRef.current = s;
}

export function registerYamlCompletions(monaco: Monaco): void {
  if (registered.has(monaco)) return;
  registered.add(monaco);

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

      const results = await buildCompletions(
        model.getValue(),
        position.lineNumber - 1,
        position.column - 1,
        registryRef.current,
        adapter,
      );
      return {
        suggestions: results.map((r) => {
          const range =
            r.replaceFromColumn !== undefined
              ? {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: r.replaceFromColumn + 1,
                  endColumn: position.column,
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
