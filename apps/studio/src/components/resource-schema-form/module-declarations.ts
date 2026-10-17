import { injectedDeclarations, injectedNeedDeclarations } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type { ParsedManifest } from "../../model";
import type { ResolvedResourceOption } from "./types";

/**
 * The names a module declares without a resource document of their own — its
 * needs and a library's `resources:` inputs — as reference candidates. They are
 * the declarations the analyzer synthesizes for the same blocks, so a picker
 * offers exactly what a `!ref` there resolves to; the slot's kind decides which
 * of them fit, as for any other candidate.
 */
export function moduleDeclarationOptions(manifest: ParsedManifest): ResolvedResourceOption[] {
  const moduleDoc = {
    kind: manifest.kind === "Library" ? "Telo.Library" : "Telo.Application",
    metadata: { name: manifest.metadata.name },
    ...(manifest.needs ? { needs: manifest.needs } : {}),
    ...(manifest.resourceInputs ? { resources: manifest.resourceInputs } : {}),
  } as unknown as ResourceManifest;
  return [
    ...injectedNeedDeclarations(moduleDoc, undefined),
    ...injectedDeclarations(moduleDoc, undefined),
  ].map((declaration) => ({ kind: declaration.kind, name: declaration.metadata.name }));
}
