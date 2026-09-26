import type { TeloDiagnosticData } from "@telorun/editor-protocol";
import type { NormalizedDiagnostic } from "@telorun/ide-support";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { fileUriToPath } from "./file-uri";
import { diagnosticMessage } from "./lsp-to-monaco";

/**
 * Every diagnostic studio shows, as the engine published it, routed for the
 * surfaces that paint it: a diagnostic the engine pinned to a resource
 * (`data.resource`) lands under that resource's name — which is what form
 * fields (by `data.path`), topology nodes and the outline paint from — and one
 * pinned to no resource under its file.
 */
export interface WorkspaceDiagnostics {
  /** filePath → resource name → diagnostics. */
  byResource: Map<string, Map<string, NormalizedDiagnostic[]>>;
  /** filePath → diagnostics tied to no resource. */
  byFile: Map<string, NormalizedDiagnostic[]>;
}

export function emptyDiagnostics(): WorkspaceDiagnostics {
  return { byResource: new Map(), byFile: new Map() };
}

function toNormalized(d: Diagnostic): NormalizedDiagnostic {
  const data = d.data as TeloDiagnosticData | undefined;
  return {
    range: d.range,
    severity: d.severity ?? 1,
    code: d.code === undefined ? "" : String(d.code),
    source: d.source ?? "telo",
    message: diagnosticMessage(d),
    ...(data?.fix
      ? {
          suggestions: [
            { kind: "replace" as const, replacement: data.fix.replacement, ...(data.fix.tag ? { tag: data.fix.tag } : {}) },
          ],
        }
      : {}),
    ...(d.tags?.length ? { tags: [...d.tags] } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/** The store after the engine published `diagnostics` for `uri`, replacing
 *  whatever that file had. */
export function withPublishedDiagnostics(
  store: WorkspaceDiagnostics,
  uri: string,
  diagnostics: Diagnostic[],
): WorkspaceDiagnostics {
  const filePath = fileUriToPath(uri);
  const byResource = new Map(store.byResource);
  const byFile = new Map(store.byFile);
  byResource.delete(filePath);
  byFile.delete(filePath);
  const resources = new Map<string, NormalizedDiagnostic[]>();
  const unpinned: NormalizedDiagnostic[] = [];
  for (const d of diagnostics) {
    const normalized = toNormalized(d);
    const name = (d.data as TeloDiagnosticData | undefined)?.resource?.name;
    if (name) resources.set(name, [...(resources.get(name) ?? []), normalized]);
    else unpinned.push(normalized);
  }
  if (resources.size) byResource.set(filePath, resources);
  if (unpinned.length) byFile.set(filePath, unpinned);
  return { byResource, byFile };
}

/** The store without a file's diagnostics — the file left the workspace. */
export function withoutFile(store: WorkspaceDiagnostics, filePath: string): WorkspaceDiagnostics {
  if (!store.byResource.has(filePath) && !store.byFile.has(filePath)) return store;
  const byResource = new Map(store.byResource);
  const byFile = new Map(store.byFile);
  byResource.delete(filePath);
  byFile.delete(filePath);
  return { byResource, byFile };
}
