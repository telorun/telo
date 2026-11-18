/**
 * What an imported library's own documents hold, each judged once per library
 * and reported at the entry's `imports:` entry first reaching it: the scope
 * members that declare kinds, the browser exports its resources name and the
 * text-keys annotations outside a kind's schema. The libraries are the full
 * documents `AnalysisOptions.moduleDocuments` holds.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { schemaDeclaresBrowserExport } from "./browser-export-slot.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { kindDocumentProblemDiagnostic } from "./kind-document-problem.js";
import { isKindDocument } from "./kind-declaration.js";
import type { ModuleDocuments } from "./module-documents.js";
import { declaringModuleScope } from "./module-alias-scope.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import type { ImportReach } from "./reaching-import.js";
import { misplacedTextKeys } from "./text-keys.js";
import type { AnalysisDiagnostic } from "./types.js";
import { validateLibraryBrowserExports } from "./validate-library-browser-exports.js";

export interface LibraryScope {
  readonly libraries: readonly ModuleDocuments[];
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  readonly reach: ImportReach;
}

/** The browser exports the libraries' resources name, held against each
 *  library's own entries. `kinds` are the kind documents of the analysed set:
 *  none declaring the annotation leaves nothing to judge. */
export function libraryBrowserExportFindings(scope: LibraryScope, kinds: readonly ResourceManifest[]): AnalysisDiagnostic[] {
  const declares = kinds.some(
    (m) => isKindDocument(m) && !!m.schema && typeof m.schema === "object" && schemaDeclaresBrowserExport(m.schema as Record<string, any>),
  );
  if (!declares) return [];
  const { defs, aliases, aliasesByModule } = scope;
  const scopes = { aliasesByModule, rootModules: new Set(scope.rootModules) };
  return validateLibraryBrowserExports({
    libraries: scope.libraries,
    rootModules: scope.rootModules,
    reach: scope.reach,
    declarationsOf: (library) => normalizeInlineResources(library.manifests, defs, aliases, aliasesByModule),
    kindSchemaOf: (resource, module) => {
      const kind = declaringModuleScope(module, aliases, scopes).resolveKind(resource.kind);
      return defs.effectiveSchemaOf(kind ? defs.resolve(kind) : undefined) as Record<string, any> | undefined;
    },
  });
}

/** A text-keys annotation outside a kind's `schema:`, on a document of a library
 *  the kernel creates — each document once. */
export function libraryTextKeyPlacementFindings(libraries: readonly ModuleDocuments[], reach: ImportReach): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const judged = new Set<string>();
  for (const library of libraries) {
    for (const m of library.manifests as ResourceManifest[]) {
      const key = `${library.module}\0${String(m.kind)}\0${String(m.metadata?.name)}`;
      if (judged.has(key)) continue;
      judged.add(key);
      for (const problem of misplacedTextKeys(m as unknown as Record<string, unknown>)) {
        out.push(kindDocumentProblemDiagnostic(m, library.module, { code: "TEXT_KEYS_INVALID", ...problem }, reach));
      }
    }
  }
  return out;
}
