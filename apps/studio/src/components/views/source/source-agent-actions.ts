import type * as MonacoApi from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";
import { fixDiagnosticPrompt, useAgentCompose, type AgentCompose } from "../../../agent";
import { fileUriToPath } from "../../../language/file-uri";
import { useAgentSelectionSource } from "../../agent-selection-source";

type MonacoEditor = MonacoApi.editor.IStandaloneCodeEditor;
type Monaco = typeof MonacoApi;

const FIX_COMMAND = "telo.agent.fixDiagnostic";

interface MarkerSubject {
  code?: string;
  file: string;
  line: number;
  message: string;
}

/**
 * The source view's ways into the agent's composer: each editor's selection is
 * carried with the next message, and "Fix with AI" is among the quick fixes of
 * a marker. Both are withdrawn where no agent panel is offered.
 */
export function useSourceAgentActions() {
  const agent = useAgentCompose();
  const agentRef = useRef<AgentCompose | null>(agent);
  const trackSelection = useAgentSelectionSource();
  const disposables = useRef<MonacoApi.IDisposable[]>([]);
  const fixRegistered = useRef(false);

  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);

  useEffect(
    () => () => {
      for (const disposable of disposables.current) disposable.dispose();
      disposables.current = [];
    },
    [],
  );

  const attach = useCallback(
    (filePath: string, editor: MonacoEditor, monaco: Monaco) => {
      disposables.current.push(
        trackSelection(`source:${filePath}`, editor, (selection) => {
          const model = editor.getModel();
          return model ? { filePath, model, range: selection } : null;
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
    [trackSelection],
  );

  return { attach };
}
