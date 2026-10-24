import type { ResourceDefinition } from "@telorun/sdk";

import { moduleScopedDefResolver, type AliasResolver, type ModuleScopes } from "./alias-resolver.js";
import type { CallGraph } from "./call-graph.js";
import { collectErrorContextScopes, errorContextForPath } from "./cel-scope.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * A `rethrow:` step re-raises the failure the in-scope `error` names, so it is
 * legal only where the nearest `x-telo-error-context` region enclosing it binds
 * an `error` that cannot be null — inside a `catch:` at any depth. In a
 * `finally:` (whose `error` is null when nothing failed) or outside every region
 * there is nothing to re-raise: `RETHROW_WITHOUT_CAUGHT_ERROR`, the step
 * engine's `ERR_RETHROW_WITHOUT_CAUGHT_ERROR`. Read off the owning kind's
 * annotations, never its name; entry-scoped.
 */
export function validateRethrowPlacement(
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  rootModules: Set<string>,
  graph: CallGraph,
  scopes: ModuleScopes,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(registry, aliases, scopes);
  const regionsByKind = new Map<string, Map<string, Record<string, any>>>();

  for (const node of graph.nodes.values()) {
    if (node.type !== "step" || !("rethrow" in node.step)) continue;
    const owner = graph.nodes.get(node.owner);
    if (owner?.type !== "resource") continue;
    const metadata = owner.manifest.metadata as Record<string, unknown> | undefined;
    const ownModule = metadata?.module as string | undefined;
    if (ownModule && !rootModules.has(ownModule)) continue;

    const definition = resolveDef(owner.kind, owner.manifest as { metadata?: { module?: string } });
    const key = `${ownModule ?? ""}\0${owner.kind}`;
    let regions = regionsByKind.get(key);
    if (!regions) {
      regions = collectErrorContextScopes(
        registry.effectiveSchemaOf(definition) as Record<string, any> | undefined,
      );
      regionsByKind.set(key, regions);
    }
    const error = errorContextForPath(node.path, regions);
    if (error && !admitsNull(error)) continue;

    out.push({
      severity: DiagnosticSeverity.Error,
      code: "RETHROW_WITHOUT_CAUGHT_ERROR",
      source: SOURCE,
      message: `${owner.kind}/${owner.name}: ` + (error
        ? `Step '${node.name ?? node.path}' re-raises a caught failure where the failure may be absent: in a finally: branch nothing has failed when the try succeeded. Move the rethrow into a catch: branch.`
        : `Step '${node.name ?? node.path}' re-raises a caught failure outside every catch: branch, where there is none to re-raise. Move it into a catch: branch, or throw a new error with throw:.`),
      data: {
        resource: { kind: owner.kind, name: owner.name },
        filePath: metadata?.source as string | undefined,
        path: `${node.path}.rethrow`,
      },
    });
  }
  return out;
}

/** Whether an `error` schema admits null: a `null` type, or a union branch that is one. */
function admitsNull(schema: Record<string, any>): boolean {
  const type = schema.type;
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some((b) => b && typeof b === "object" && admitsNull(b))) return true;
  }
  return false;
}
