import type * as MonacoApi from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { fixDiagnosticPrompt, selectionPrompt, useAgentCompose, type AgentCompose } from "../../../agent";
import { fileUriToPath } from "../../../language/file-uri";

type MonacoEditor = MonacoApi.editor.IStandaloneCodeEditor;
type Monaco = typeof MonacoApi;

const AVAILABLE_CONTEXT_KEY = "teloAgentAvailable";
const FIX_COMMAND = "telo.agent.fixDiagnostic";

interface MarkerSubject {
  code?: string;
  file: string;
  line: number;
  message: string;
}

/**
 * The source view's two ways into the agent's composer: "Send selection to
 * chat" in each editor's context menu, and "Fix with AI" among the quick fixes
 * of a marker. Both are withdrawn where no agent panel is offered.
 */
export function useSourceAgentActions() {
  const agent = useAgentCompose();
  const agentRef = useRef<AgentCompose | null>(agent);
  const editors = useRef(new Map<string, MonacoEditor>());
  const availability = useRef(new Map<string, { set(value: boolean): void }>());
  const disposables = useRef<MonacoApi.IDisposable[]>([]);
  const fixRegistered = useRef(false);
  /** The files whose editor holds a non-empty selection. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    agentRef.current = agent;
    for (const key of availability.current.values()) key.set(agent !== null);
  }, [agent]);

  useEffect(
    () => () => {
      for (const disposable of disposables.current) disposable.dispose();
      disposables.current = [];
    },
    [],
  );

  const sendSelection = useCallback((filePath: string) => {
    const editor = editors.current.get(filePath);
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    const compose = agentRef.current;
    if (!selection || !model || !compose || selection.isEmpty()) return;
    // A selection ending at a line's first column does not include that line.
    const endLine =
      selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
        ? selection.endLineNumber - 1
        : selection.endLineNumber;
    compose.compose(
      selectionPrompt({
        file: compose.workspaceFile(filePath),
        startLine: selection.startLineNumber,
        endLine,
        text: model.getValueInRange(selection),
      }),
    );
  }, []);

  const attach = useCallback(
    (filePath: string, editor: MonacoEditor, monaco: Monaco) => {
      editors.current.set(filePath, editor);
      availability.current.set(filePath, editor.createContextKey(AVAILABLE_CONTEXT_KEY, agentRef.current !== null));
      disposables.current.push(
        editor.addAction({
          id: "telo.agent.sendSelection",
          label: "Send selection to chat",
          precondition: `editorHasSelection && ${AVAILABLE_CONTEXT_KEY}`,
          contextMenuGroupId: "navigation",
          contextMenuOrder: 9,
          run: () => sendSelection(filePath),
        }),
        editor.onDidChangeCursorSelection((event) => {
          const has = !event.selection.isEmpty();
          setSelected((current) => {
            if (current.has(filePath) === has) return current;
            const next = new Set(current);
            if (has) next.add(filePath);
            else next.delete(filePath);
            return next;
          });
        }),
        editor.onDidDispose(() => {
          editors.current.delete(filePath);
          availability.current.delete(filePath);
        }),
      );
      if (fixRegistered.current) return;
      fixRegistered.current = true;
      disposables.current.push(
        monaco.editor.registerCommand(FIX_COMMAND, (accessor, subject: MarkerSubject) => {
          const compose = agentRef.current;
          if (!compose) return;
          compose.compose(fixDiagnosticPrompt({ ...subject, file: compose.workspaceFile(subject.file) }));
        }),
        monaco.languages.registerCodeActionProvider("yaml", {
          provideCodeActions(model, range, context) {
            // A workspace file only: a projected slice has lines of its own.
            const offered =
              agentRef.current !== null &&
              model.uri.scheme === "file" &&
              (!context.only || context.only.startsWith("quickfix"));
            const actions = (offered ? context.markers : []).map((marker) => {
              const code = typeof marker.code === "object" ? marker.code.value : marker.code;
              const subject: MarkerSubject = {
                code,
                file: fileUriToPath(model.uri.toString()),
                line: marker.startLineNumber,
                message: marker.message,
              };
              return {
                title: code ? `Fix with AI: ${code}` : "Fix with AI",
                kind: "quickfix",
                diagnostics: [marker],
                command: { id: FIX_COMMAND, title: "Fix with AI", arguments: [subject] },
              };
            });
            return { actions, dispose: () => undefined };
          },
        }),
      );
    },
    [sendSelection],
  );

  return {
    attach,
    /** Whether `filePath`'s selection can be sent: an agent panel is offered
     *  and something is selected. */
    canSend: (filePath: string) => agent !== null && selected.has(filePath),
    sendSelection,
  };
}
