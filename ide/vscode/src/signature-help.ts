import { buildSignatureHelp } from "@telorun/ide-support";
import * as vscode from "vscode";
import type { TeloAnalysisCache } from "./analysis-cache.js";

/** Signature help for a module call inside a CEL body — `Billing.total(` shows
 *  the function's parameters, with the one being written highlighted. */
export class TeloSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly cache: TeloAnalysisCache) {}

  provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.SignatureHelp | undefined {
    if (document.languageId !== "telo" && document.languageId !== "yaml") return undefined;
    const filePath = document.uri.fsPath;
    const text = document.getText();
    const result = buildSignatureHelp(
      text,
      position.line,
      position.character,
      this.cache.docsFor(filePath, text),
      this.cache.analysisFor(filePath),
    );
    if (!result) return undefined;
    const help = new vscode.SignatureHelp();
    help.signatures = result.signatures.map((signature) => {
      const information = new vscode.SignatureInformation(
        signature.label,
        signature.documentation ? new vscode.MarkdownString(signature.documentation) : undefined,
      );
      information.parameters = signature.parameters.map(
        (parameter) => new vscode.ParameterInformation(parameter.label, parameter.documentation),
      );
      return information;
    });
    help.activeSignature = result.activeSignature;
    help.activeParameter = result.activeParameter;
    return help;
  }
}
