import type * as Monaco from "monaco-editor";
import type { CelFieldCompletionParams, LanguageSession } from "./language-session";
import { toCompletionItem, type MonacoApi } from "./lsp-to-monaco";

/** The form field a CEL editor's model holds the value of. */
export type CelFieldSite = Omit<CelFieldCompletionParams, "text" | "offset">;

/**
 * Completion at `position` in a CEL editor whose model holds a form field's
 * value without its tag, asked of the engine the field's module is edited
 * against. An item's edit range is a range in that value, which is the whole
 * model, so it maps onto the model as it stands.
 */
export async function celFieldCompletions(
  monaco: MonacoApi,
  session: Pick<LanguageSession, "celCompletion">,
  site: CelFieldSite,
  model: Monaco.editor.ITextModel,
  position: Monaco.IPosition,
): Promise<Monaco.languages.CompletionList> {
  const items = await session.celCompletion({
    ...site,
    text: model.getValue(),
    offset: model.getOffsetAt(position),
  });
  const word = model.getWordUntilPosition(position);
  const range = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
  return { suggestions: items.map((item) => toCompletionItem(monaco, item, range)) };
}
