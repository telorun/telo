import type { ResourceManifest } from "@telorun/sdk";
import type { CallGraph, ResourceGraphNode } from "./call-graph.js";
import { coReferrerScopedMessage, registeredCoReferrerCalls, scopedCoReferrerCalls } from "./co-referrers.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { importAnchoredDiagnostic, type ImportReach } from "./reaching-import.js";
import { isResolvedReference } from "./resolved-reference.js";
import { pointerToPath } from "./resource-rule.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

export const CO_REFERRER_SCOPED = "CO_REFERRER_SCOPED";

/**
 * `CO_REFERRER_SCOPED` — a scope member that would be a co-referrer: its kind is
 * one a registered `callsCoReferrers` names (or extends it) and it holds a
 * reference at that call's slot; and a co-referrer in the library instance a
 * scoped `Telo.Import` reaches whose target lives in an instance that outlives
 * it (the application's, a `shared` library's, an enclosing scope's). Reported
 * at the member for the entry's own modules, and at the import reaching a
 * dependency's — an `imports:` entry, or the scoped `Telo.Import` itself.
 */
export function coReferrerScopedDiagnostics(
  graph: CallGraph,
  defs: DefinitionRegistry,
  rootModules: ReadonlySet<string>,
  reach: ImportReach,
  /** A declaration's canonical kind, resolved in its module's scope. */
  kindOf: (manifest: ResourceManifest) => string | undefined,
): AnalysisDiagnostic[] {
  const resolve = (kind: string) => defs.resolve(kind);
  const scoped = [...graph.nodes.values()].filter(
    (node): node is ResourceGraphNode => node.type === "resource" && node.scoped === true,
  );
  // A module-scope declaration of a scoped import's library instance lives as
  // long as one run of that scope.
  const inScopedInstance = [...graph.nodes.values()].filter(
    (node): node is ResourceGraphNode =>
      node.type === "resource" && !node.scoped && graph.lifetimeDomainOf?.(node.id) !== undefined,
  );
  if (scoped.length === 0 && inScopedInstance.length === 0) return [];
  const calls = registeredCoReferrerCalls(
    defs.kinds().flatMap((kind) => defs.resolve(kind) ?? []),
    resolve,
  );
  if (calls.length === 0) return [];

  const out: AnalysisDiagnostic[] = [];
  const report = (node: ResourceGraphNode, message: string, slot: string): void => {
    const module = (node.manifest.metadata as { module?: string } | undefined)?.module;
    const via = module && !rootModules.has(module) ? reach.of(module) : undefined;
    out.push(
      via
        ? importAnchoredDiagnostic(CO_REFERRER_SCOPED, module!, via, message)
        : {
            severity: DiagnosticSeverity.Error,
            code: CO_REFERRER_SCOPED,
            source: "telo-analyzer",
            message,
            data: {
              resource: { kind: node.kind, name: node.name },
              filePath: (node.manifest.metadata as { source?: string } | undefined)?.source,
              path: slot,
            },
          },
    );
  };
  // A co-referrer in a scoped import's library naming a target that outlives
  // that instance: the dispatch its target's domain answers never reaches it.
  for (const node of inScopedInstance) {
    const domain = graph.lifetimeDomainOf!(node.id)!;
    const kind = kindOf(node.manifest);
    if (!kind) continue;
    const written = new Map<string, { shown: string; to?: string }>();
    for (const edge of graph.edgesFrom(node.id)) {
      if (edge.nested || edge.moduleCall || edge.coReferrer || written.has(edge.path)) continue;
      written.set(edge.path, { shown: shownReference(node.manifest, edge.path) ?? edge.toName, to: edge.to });
    }
    for (const call of scopedCoReferrerCalls(kind, new Set(written.keys()), calls, resolve)) {
      const slot = pointerToPath(call.slot);
      const target = written.get(slot)!;
      if (!target.to || graph.lifetimeDomainOf!(target.to)?.key === domain.key) continue;
      report(
        node,
        coReferrerScopedMessage({
          kind: node.kind,
          name: node.name,
          target: target.shown,
          slot,
          scope: domain.field,
          owner: domain.holders[domain.holders.length - 1] ?? "",
          through: domain.alias,
        }),
        slot,
      );
    }
  }
  for (const node of scoped) {
    const kind = kindOf(node.manifest);
    if (!kind) continue;
    const written = new Map<string, string>();
    for (const edge of graph.edgesFrom(node.id)) {
      if (edge.nested || edge.moduleCall || edge.coReferrer || written.has(edge.path)) continue;
      written.set(edge.path, shownReference(node.manifest, edge.path) ?? edge.toName);
    }
    for (const call of scopedCoReferrerCalls(kind, new Set(written.keys()), calls, resolve)) {
      const slot = pointerToPath(call.slot);
      const owner = node.scopeOwner ? graph.nodes.get(node.scopeOwner) : undefined;
      const message = coReferrerScopedMessage({
        kind: node.kind,
        name: node.name,
        target: written.get(slot)!,
        slot,
        scope: (node.scopeSite ?? "").replace(/^\//, ""),
        owner: owner?.type === "resource" ? owner.name : "",
      });
      report(node, message, slot);
    }
  }
  return out;
}

/** The reference at `path` of `manifest` as written (`Lib.Joined`). */
function shownReference(manifest: ResourceManifest, path: string): string | undefined {
  let value: unknown = manifest;
  for (const key of path.split(/[.[\]]/).filter((k) => k !== "")) {
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  const sentinel = refSentinelTarget(value);
  if (sentinel) return sentinel.source;
  if (isResolvedReference(value)) {
    const { alias, name } = value as { alias?: unknown; name: string };
    return typeof alias === "string" && alias !== "Self" ? `${alias}.${name}` : name;
  }
  return undefined;
}
