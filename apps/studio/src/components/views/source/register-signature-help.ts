import type { OnMount } from "@monaco-editor/react";
import type { Position, editor, languages } from "monaco-editor";
import { buildSignatureHelp } from "@telorun/ide-support";
import { analysisRef, threadedDocs } from "./provider-state";

type Monaco = Parameters<OnMount>[1];

/** Signature help for a module call inside a CEL body. */
export function registerYamlSignatureHelp(monaco: Monaco): void {
  monaco.languages.registerSignatureHelpProvider("yaml", {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp(
      model: editor.ITextModel,
      position: Position,
    ): languages.SignatureHelpResult | undefined {
      const text = model.getValue();
      const result = buildSignatureHelp(
        text,
        position.lineNumber - 1,
        position.column - 1,
        threadedDocs(text),
        analysisRef.current,
      );
      if (!result) return undefined;
      return {
        value: {
          signatures: result.signatures.map((signature) => ({
            label: signature.label,
            documentation: signature.documentation ? { value: signature.documentation } : undefined,
            parameters: signature.parameters.map((parameter) => ({
              label: parameter.label,
              documentation: parameter.documentation,
            })),
          })),
          activeSignature: result.activeSignature,
          activeParameter: result.activeParameter,
        },
        dispose: () => {},
      };
    },
  });
}
