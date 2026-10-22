import type { ResourceManifest } from "@telorun/sdk";
import { browserExportProblems, browserExportSites } from "./browser-export-slot.js";
import { isKindDocument } from "./kind-declaration.js";
import { readBrowserEntries } from "./module-browser.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { importAnchoredDiagnostic, type ImportReach } from "./reaching-import.js";
import type { AnalysisDiagnostic } from "./types.js";

export interface LibraryBrowserExportsInput {
  /** Every imported library's full documents (`AnalysisOptions.moduleDocuments`). */
  libraries: readonly ModuleDocuments[];
  rootModules: ReadonlySet<string>;
  reach: ImportReach;
  /** The library's resources as the kernel creates them: its documents with
   *  their inline declarations extracted. */
  declarationsOf(library: ModuleDocuments): readonly ResourceManifest[];
  /** The author-facing schema of a resource's kind, resolved in the alias scope
   *  of the library that declared the resource. */
  kindSchemaOf(resource: ResourceManifest, module: string): Record<string, any> | undefined;
}

/**
 * A value an imported library's resource names a browser export with, judged as
 * the kernel judges it when the import creates the resource — against that
 * library's own `exports.browser` — and reported at the entry's `imports:` entry
 * through which the library is first reached: the kernel refuses the consumer's
 * run all the same, and the library's file is not a line the consumer can
 * change. Only the version of a library the application loads is judged, and
 * each finding is reported once however many imports reach it.
 *
 * Browser-safe.
 */
export function validateLibraryBrowserExports(input: LibraryBrowserExportsInput): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const reported = new Set<string>();
  for (const library of input.libraries) {
    if (input.rootModules.has(library.module) || !input.reach.loads(library)) continue;
    const via = input.reach.of(library.module);
    if (!via) continue;
    const owner = library.manifests.find((m) => isModuleKind(m.kind));
    const entries = owner ? readBrowserEntries(owner).entries : [];
    for (const resource of input.declarationsOf(library)) {
      if (!resource.kind || isModuleKind(resource.kind) || resource.kind === "Telo.Import" || isKindDocument(resource)) {
        continue;
      }
      const schema = input.kindSchemaOf(resource, library.module);
      if (!schema) continue;
      const sites = browserExportSites(schema, resource);
      if (sites.length === 0) continue;
      for (const problem of browserExportProblems(sites, entries)) {
        const message = `${resource.kind}/${resource.metadata?.name as string}: ${problem.message}`;
        const key = `${problem.code}\0${library.module}\0${message}`;
        if (reported.has(key)) continue;
        reported.add(key);
        out.push(importAnchoredDiagnostic(problem.code, library.module, via, message));
      }
    }
  }
  return out;
}
