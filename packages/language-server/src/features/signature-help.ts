import { buildSignatureHelp } from "@telorun/ide-support";
import { MarkupKind } from "vscode-languageserver/browser";
import { sourceOfUri } from "../document-uri.js";
import type { FeatureContext } from "./context.js";

export const SIGNATURE_HELP_TRIGGERS = ["(", ","];

/** Signature help for a module call inside a CEL body — `Billing.total(` shows
 *  the function's parameters, with the one being written highlighted. */
export function registerSignatureHelp({ connection, documents, session }: FeatureContext): void {
  connection.onSignatureHelp((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const analysis = session.documentAnalysis(sourceOfUri(params.textDocument.uri));
    const text = document.getText();
    const result = buildSignatureHelp(
      text,
      params.position.line,
      params.position.character,
      analysis.docsFor(text),
      analysis.analysis,
    );
    if (!result) return null;
    return {
      signatures: result.signatures.map((signature) => ({
        label: signature.label,
        ...(signature.documentation
          ? { documentation: { kind: MarkupKind.Markdown, value: signature.documentation } }
          : {}),
        parameters: signature.parameters.map((parameter) => ({
          label: parameter.label,
          ...(parameter.documentation ? { documentation: parameter.documentation } : {}),
        })),
      })),
      activeSignature: result.activeSignature,
      activeParameter: result.activeParameter,
    };
  });
}
