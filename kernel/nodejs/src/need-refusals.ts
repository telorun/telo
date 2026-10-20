import type { AnalysisDiagnostic } from "@telorun/analyzer";
import { RuntimeError, type RuntimeErrorCode } from "@telorun/sdk";
import { staticDiagnosticToRuntime } from "./static-analysis-diagnostics.js";
import { UnresolvedInputsError, type UnresolvedApplicationInput } from "./unresolved-inputs.js";

export interface NeedRefusal {
  runtimeCode: string;
  message: string;
  filePath?: string;
  path: string;
  resource?: { kind: string; name: string };
}

/** Need refusals raised together with the rest of the analysis's errors, each
 *  line naming its own code — the error's code is only the first refusal's — so
 *  every one is findable on a child kernel's stderr. Carrying `unresolved` makes
 *  it a missing-values refusal a host could have asked about. */
export function needRefusalError(
  refusals: readonly NeedRefusal[],
  others: readonly AnalysisDiagnostic[] = [],
  unresolved?: readonly UnresolvedApplicationInput[],
): RuntimeError {
  const [first] = refusals;
  const rest = others.map(staticDiagnosticToRuntime);
  const message = [
    ...refusals.map((p) => `${p.filePath ? `${p.filePath}: ` : ""}${p.message} (${p.runtimeCode})`),
    ...rest.map((d) => {
      const filePath = d.origin?.filePath;
      return `${filePath ? `${filePath}: ` : ""}${d.message}${d.code ? ` (${d.code})` : ""}`;
    }),
  ].join("\n");
  const diagnostics = [
    ...refusals.map((p) => ({
      severity: "error" as const,
      message: p.message,
      code: p.runtimeCode,
      ...(p.resource ? { resource: `${p.resource.kind}.${p.resource.name}` } : {}),
      origin: {
        ...(p.filePath !== undefined ? { filePath: p.filePath } : {}),
        path: p.path,
        ...(p.resource ? { resource: p.resource } : {}),
      },
    })),
    ...rest,
  ];
  const code = first!.runtimeCode as RuntimeErrorCode;
  return unresolved
    ? new UnresolvedInputsError(code, message, unresolved, diagnostics)
    : new RuntimeError(code, message, diagnostics);
}
