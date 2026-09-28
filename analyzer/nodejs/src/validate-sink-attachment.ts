import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { nodeIdFor, type CallGraph } from "./call-graph.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * `SINK_UNATTACHED` — a sink nothing will ever attach.
 *
 * The runtime attaches exactly the instances the root Application's
 * `logging.sinks` / `tracing.sinks` name; a sink never attaches itself. So a sink
 * declared and never referenced receives no record and no span, which reads to
 * its author as a destination that silently stopped working.
 *
 * A sink is recognized by its kind's capability, never by a kind name. A sink
 * its module EXPORTS is left alone: an importer may list it. Reported for the
 * entry's own modules only — a dependency's declarations are not the consumer's
 * to fix. A warning, since an unattached sink breaks nothing else.
 */
export function validateSinkAttachment(
  manifests: readonly ResourceManifest[],
  graph: CallGraph,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const exported = new Map<string, Set<string>>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Library") continue;
    const names = (m as { exports?: { resources?: unknown } }).exports?.resources;
    if (Array.isArray(names)) {
      exported.set(m.metadata?.name as string, new Set(names.filter((n) => typeof n === "string")));
    }
  }

  const diagnostics: AnalysisDiagnostic[] = [];
  for (const m of manifests) {
    if (typeof m.kind !== "string") continue;
    const module = (m.metadata as { module?: string } | undefined)?.module;
    if (module !== undefined && !rootModules.has(module)) continue;
    const resolver = moduleAliasScope(m.metadata, aliases, aliasesByModule);
    const canonical = resolver.resolveKind(m.kind) ?? m.kind;
    const definition = registry.resolve(canonical);
    if (definition?.kind === "Telo.Abstract" || definition?.capability !== "Telo.Sink") continue;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    if (graph.edgesTo(nodeIdFor(m)).length > 0) continue;
    if (module !== undefined && exported.get(module)?.has(name)) continue;
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      code: "SINK_UNATTACHED",
      source: SOURCE,
      message:
        `${m.kind}/${name} is a sink nothing attaches: the runtime attaches only the sinks the ` +
        `root Application lists in \`logging.sinks\` / \`tracing.sinks\`, so this one receives ` +
        `nothing. List it there (\`- !ref ${name}\`), or remove it.`,
      data: {
        resource: { kind: m.kind, name },
        filePath: (m.metadata as { source?: string } | undefined)?.source,
      },
    });
  }
  return diagnostics;
}
