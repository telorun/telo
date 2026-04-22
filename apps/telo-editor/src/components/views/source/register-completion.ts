import type { OnMount } from "@monaco-editor/react";
import type { AnalysisRegistry } from "@telorun/analyzer";
import { buildCompletions } from "@telorun/ide-support";

type Monaco = Parameters<OnMount>[1];

/** Module-scoped single registration state. Monaco's language providers are
 *  process-wide — registering inside a component's onMount would stack a new
 *  provider on every mount. A WeakSet keyed on the monaco instance keeps one
 *  registration per runtime. */
const registered = new WeakSet<Monaco>();
const registryRef: { current: AnalysisRegistry | undefined } = { current: undefined };

/** Updates the active registry the provider consults. Called from Editor.tsx
 *  after each analysis pass. The provider reads through this ref so completion
 *  never goes stale even though registration happened once at mount. */
export function setActiveRegistry(r: AnalysisRegistry | undefined): void {
  registryRef.current = r;
}

export function registerYamlCompletions(monaco: Monaco): void {
  if (registered.has(monaco)) return;
  registered.add(monaco);

  const kindMap = {
    class: monaco.languages.CompletionItemKind.Class,
    enumMember: monaco.languages.CompletionItemKind.EnumMember,
    property: monaco.languages.CompletionItemKind.Property,
  } as const;

  monaco.languages.registerCompletionItemProvider("yaml", {
    triggerCharacters: [" ", ":"],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const results = buildCompletions(
        model.getValue(),
        position.lineNumber - 1,
        position.column - 1,
        registryRef.current,
      );
      return {
        suggestions: results.map((r) => ({
          label: r.label,
          kind: kindMap[r.kind],
          detail: r.detail,
          documentation: r.documentation,
          insertText: r.insertText ?? r.label,
          insertTextRules: r.snippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : monaco.languages.CompletionItemInsertTextRule.None,
          sortText: r.sortText,
          preselect: r.preselect,
          range,
        })),
      };
    },
  });
}
