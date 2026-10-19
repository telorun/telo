import type * as MonacoApi from "monaco-editor";
import { useCallback, useRef } from "react";
import { useAgentCompose, type EditorSelection } from "../agent";

/** Where a selection is in a workspace file: the file's own model and range. */
export interface LocatedSelection {
  filePath: string;
  model: MonacoApi.editor.ITextModel;
  range: MonacoApi.IRange;
}

/**
 * Reports an editor's selection to the agent's composer, which carries it with
 * the next message. `locate` places a selection in its workspace file — null
 * when it names none; by default the editor's own model is that file.
 */
export function useAgentSelectionSource() {
  const agent = useAgentCompose();
  const agentRef = useRef(agent);
  agentRef.current = agent;

  return useCallback(
    (
      source: string,
      editor: MonacoApi.editor.IStandaloneCodeEditor,
      locate: (selection: MonacoApi.Selection) => LocatedSelection | null,
    ): MonacoApi.IDisposable => {
      const report = (selection: MonacoApi.Selection | null) => {
        const compose = agentRef.current;
        if (!compose) return;
        const located = selection && !selection.isEmpty() ? locate(selection) : null;
        compose.select(source, located && editorSelection(compose.workspaceFile(located.filePath), located));
      };
      const listeners = [
        editor.onDidChangeCursorSelection((event) => report(event.selection)),
        editor.onDidDispose(() => report(null)),
      ];
      return {
        dispose: () => {
          for (const listener of listeners) listener.dispose();
          report(null);
        },
      };
    },
    [],
  );
}

function editorSelection(file: string, { model, range }: LocatedSelection): EditorSelection | null {
  const text = model.getValueInRange(range);
  if (text.trim() === "") return null;
  // A selection ending at a line's first column does not include that line.
  const endLine =
    range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range.endLineNumber;
  return { file, startLine: range.startLineNumber, endLine, text };
}
