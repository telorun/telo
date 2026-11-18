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
  const placement = rethrowPlacement(registry, aliases, rootModules, scopes);
  for (const node of graph.nodes.values()) {
    if (node.type !== "step" || !("rethrow" in node.step)) continue;
    const owner = graph.nodes.get(node.owner);
    if (owner?.type !== "resource" || !placement.reported(owner)) continue;
    const found = placement.issue(owner, node);
    if (found) out.push(found);
  }
  return out;
}

/** The one rule of a `rethrow:` step's place, over its owner's kind. */
export function rethrowPlacement(
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  rootModules: ReadonlySet<string>,
  scopes: ModuleScopes,
) {
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(registry, aliases, scopes);
  const regionsByKind = new Map<string, Map<string, Record<string, any>>>();
  const regionsOf = (owner: RethrowOwner) => {
    const ownModule = (owner.manifest.metadata as { module?: string } | undefined)?.module;
    const key = `${ownModule ?? ""}\0${owner.kind}`;
    let regions = regionsByKind.get(key);
    if (!regions) {
      const definition = resolveDef(owner.kind, owner.manifest as { metadata?: { module?: string } });
      regions = collectErrorContextScopes(registry.effectiveSchemaOf(definition) as Record<string, any> | undefined);
      regionsByKind.set(key, regions);
    }
    return regions;
  };
  return {
    /** Whether a step `owner` declares is the entry's to fix. */
    reported(owner: RethrowOwner): boolean {
      const ownModule = (owner.manifest.metadata as { module?: string } | undefined)?.module;
      return !ownModule || rootModules.has(ownModule);
    },
    /** The refusal of a `rethrow:` step at `step.path` of `owner`, none where
     *  a caught failure is always in scope there. */
    issue(owner: RethrowOwner, step: { path: string; name?: string }): AnalysisDiagnostic | undefined {
      const error = errorContextForPath(step.path, regionsOf(owner));
      if (error && !admitsNull(error)) return undefined;
      const metadata = owner.manifest.metadata as Record<string, unknown> | undefined;
      return {
        severity: DiagnosticSeverity.Error,
        code: "RETHROW_WITHOUT_CAUGHT_ERROR",
        source: SOURCE,
        message: `${owner.kind}/${owner.name}: ` + (error
          ? `Step '${step.name ?? step.path}' re-raises a caught failure where the failure may be absent: in a finally: branch nothing has failed when the try succeeded. Move the rethrow into a catch: branch.`
          : `Step '${step.name ?? step.path}' re-raises a caught failure outside every catch: branch, where there is none to re-raise. Move it into a catch: branch, or throw a new error with throw:.`),
        data: {
          resource: { kind: owner.kind, name: owner.name },
          filePath: metadata?.source as string | undefined,
          path: `${step.path}.rethrow`,
        },
      };
    },
  };
}

/** The resource declaring a step: its kind, its name and its manifest. */
export interface RethrowOwner {
  readonly kind: string;
  readonly name: string;
  readonly manifest: { readonly metadata?: unknown };
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
