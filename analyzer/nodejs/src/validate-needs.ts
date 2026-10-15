import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { needSupplyOf, needTypeOf, readSuppliedNeeds } from "./need-type.js";
import {
  needGraphFromManifests,
  resolveNeedTable,
  type NeedGraph,
  type NeedGraphImport,
} from "./need-table.js";
import type { ModuleDocuments } from "./module-documents.js";
import type { ReachSite } from "./reference-reach.js";
import { type AnalysisDiagnostic, DiagnosticSeverity } from "./types.js";

const SOURCE = "telo-analyzer";

/** The `data` key marking a diagnostic the need table also raises. */
export const NEED_TABLE_MARK = "needTable";

/** True for a diagnostic the need table produced — one the kernel raises as its
 *  `ERR_` twin when it resolves the same table over the loaded graph, so a load
 *  refuses with that twin rather than with the analysis's aggregate. */
export function isNeedTableDiagnostic(diagnostic: AnalysisDiagnostic): boolean {
  return (diagnostic.data as Record<string, unknown> | undefined)?.[NEED_TABLE_MARK] === true;
}

/**
 * The need table's refusals, as `telo check` reports them. A problem in the
 * entry's own modules is reported where it is written. One in an imported
 * library — the analysis builds every library it holds documents for whole —
 * is reported once, at the entry's `imports:` entry that reaches the library:
 * the kernel refuses the consumer at load all the same, and the repair is the
 * library's, so the consumer is told which import brings it in.
 */
export function needTableDiagnostics(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  resolveKind: (module: string, kind: string) => string | undefined,
  resolveDefinition: (kind: string) => ResourceDefinition | undefined,
  libraries: readonly ModuleDocuments[] = [],
  referenceSites?: (manifest: ResourceManifest) => readonly ReachSite[],
): AnalysisDiagnostic[] {
  const graph = needGraphFromManifests(
    manifests,
    rootModules,
    {
      resolveKind,
      needType: (kind) => needTypeOf(resolveDefinition(kind)),
      isKind: (kind) => resolveDefinition(kind) !== undefined,
      ...(referenceSites ? { referenceSites } : {}),
    },
    libraries,
  );
  if (!graph) return [];
  const reaching = reachingImports(graph, rootModules);
  const out: AnalysisDiagnostic[] = [];
  const reported = new Set<string>();
  for (const p of resolveNeedTable(graph).problems) {
    if (rootModules.has(p.module)) {
      if (p.reportedElsewhere) continue;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: p.code,
        source: SOURCE,
        message: p.message,
        data: {
          ...(p.resource ? { resource: p.resource } : {}),
          filePath: p.filePath,
          path: p.path,
          [NEED_TABLE_MARK]: true,
        },
      });
      continue;
    }
    const via = reaching.get(p.module);
    if (!via) continue;
    const key = `${p.code}\0${p.module}\0${p.message}`;
    if (reported.has(key)) continue;
    reported.add(key);
    out.push({
      severity: DiagnosticSeverity.Error,
      code: p.code,
      source: SOURCE,
      message:
        `Imported library '${p.module}', reached through import '${via.alias}': ${p.message} ` +
        `The repair is the library's — import a version of it that resolves this.`,
      data: {
        resource: { kind: "Telo.Import", name: via.alias },
        filePath: (via.manifest.metadata as { source?: string } | undefined)?.source,
        path: "",
        [NEED_TABLE_MARK]: true,
      },
    });
  }
  return out;
}

/** For every module of the graph that is not one of the entry's own: the
 *  entry's import through which it is first reached. */
function reachingImports(
  graph: NeedGraph,
  rootModules: ReadonlySet<string>,
): Map<string, NeedGraphImport> {
  const out = new Map<string, NeedGraphImport>();
  for (const module of graph.modules.values()) {
    if (!rootModules.has(module.name)) continue;
    for (const imp of module.imports) {
      const queue = imp.target ? [imp.target] : [];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const key = queue.shift()!;
        if (seen.has(key)) continue;
        seen.add(key);
        const target = graph.modules.get(key);
        if (!target || rootModules.has(target.name)) continue;
        if (!out.has(target.name)) out.set(target.name, imp);
        for (const next of target.imports) if (next.target) queue.push(next.target);
      }
    }
  }
  return out;
}

/**
 * The schema an import's field-by-field `needs:` supply is held to — each
 * supplied field typed by the target's need type — so an expression's type is
 * judged against the field it fills, as a resource field's is. Undefined for a
 * document that supplies no need field by field.
 */
export function importNeedsSlotSchema(
  importDoc: ResourceManifest,
  resolveKind: (module: string, kind: string) => string | undefined,
  resolveDefinition: (kind: string) => ResourceDefinition | undefined,
): Record<string, unknown> | undefined {
  if (importDoc.kind !== "Telo.Import") return undefined;
  const meta = importDoc.metadata as {
    resolvedModuleName?: string;
    requiredNeeds?: Record<string, { kind: string }>;
  };
  const target = meta.resolvedModuleName;
  if (!target || !meta.requiredNeeds) return undefined;
  const needs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(readSuppliedNeeds(importDoc))) {
    const declared = meta.requiredNeeds[name];
    if (!declared || needSupplyOf(value).form !== "fields") continue;
    const type = resolveKind(target, declared.kind);
    const shape = type ? needTypeOf(resolveDefinition(type)) : undefined;
    if (!shape) continue;
    needs[name] = { type: "object", properties: shape.fields };
  }
  if (Object.keys(needs).length === 0) return undefined;
  return { type: "object", properties: { needs: { type: "object", properties: needs } } };
}
