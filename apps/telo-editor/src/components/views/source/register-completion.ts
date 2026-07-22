import type { OnMount } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";
import type { AnalysisRegistry, AstDocument } from "@telorun/analyzer";
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
/** The active file's already-parsed AST plus the exact text it was parsed
 *  from. Completion reuses it only when the live buffer still matches that
 *  text, so a keystroke ahead of the next analysis pass falls back to a local
 *  parse rather than resolving against a stale tree. */
const docsRef: { current: { text: string; docs: AstDocument[] } | undefined } = {
  current: undefined,
};

/** Updates the active registry the provider consults. Called from Editor.tsx
 *  after each analysis pass. The provider reads through this ref so completion
 *  never goes stale even though registration happened once at mount. */
export function setActiveRegistry(r: AnalysisRegistry | undefined): void {
  registryRef.current = r;
}

/** Updates the active file's parsed AST (from the same analysis pass) so
 *  completion can skip re-parsing when the buffer is unchanged. */
export function setActiveDocs(
  entry: { text: string; docs: AstDocument[] } | undefined,
): void {
  docsRef.current = entry;
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

      const text = model.getValue();
      const threaded =
        docsRef.current && docsRef.current.text === text ? docsRef.current.docs : undefined;
      const results = await buildCompletions(
        text,
        position.lineNumber - 1,
        position.column - 1,
        registryRef.current,
        adapter,
        threaded,
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
