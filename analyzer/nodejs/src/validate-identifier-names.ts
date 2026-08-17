import type { ResourceManifest } from "@telorun/sdk";

import type { AliasResolver } from "./alias-resolver.js";
import type { CallGraph } from "./call-graph.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  TYPE_LEVEL_DOC_KINDS,
  checkName,
  type NameLevel,
  type NameViolation,
} from "./identifier-name.js";
import { type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * Every author-written name in one pass — resource instances, kinds, modules,
 * import aliases, step names and `variables` / `secrets` / `ports` keys. The
 * rules and their rationale are in `identifier-name.ts`; this file only decides
 * what each name IS and where to report it.
 *
 * One pass rather than a check bolted onto each surface's own validator: the
 * rule is identical everywhere, and seven copies of it would drift the way the
 * dot rule already had (enforced for resources, unenforced for steps, aliases
 * and config declarations, which reach CEL through the same identifier space).
 *
 * **Step names come from the call graph, never from a walk of our own.** The
 * graph already owns the analyzer's only step-array recursion and carries each
 * step's name, owner and concrete path, which is exactly what a diagnostic
 * needs. Re-walking would be a second answer to "what steps exist".
 *
 * **Scoped to the entry's own modules, at every tier including the errors.** A
 * published dependency's naming is not the consumer's to fix, and reporting an
 * error they cannot act on is worse than not reporting it — the standing
 * precedent of `X_TELO_REF_UNRESOLVED` and `validate-extends`. The library's
 * own author sees all of it when their module is analyzed as a root.
 *
 * Browser-safe.
 */
export function validateIdentifierNames(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  rootModules: Set<string>,
  graph: CallGraph,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];

  for (const manifest of manifests) {
    const metadata = manifest.metadata as Record<string, unknown> | undefined;
    const name = typeof metadata?.name === "string" ? metadata.name : undefined;
    if (!manifest.kind || !name) continue;

    // A name synthesized by inline extraction (`TestAdd_steps_0_invoke`) is
    // derived from the author's own names, not written — reporting its shape
    // would blame them for a spelling this pass's own pipeline chose.
    if (metadata?.xTeloOrigin) continue;

    const ownModule = metadata?.module as string | undefined;
    if (ownModule && !rootModules.has(ownModule)) continue;

    const level = levelFor(manifest, registry, aliases);
    push(out, checkName(name, level, surfaceFor(manifest.kind)), {
      kind: manifest.kind,
      name,
      filePath: metadata?.source as string | undefined,
      path: "metadata.name",
    });

    // The module doc's config contract. Each key becomes `variables.<key>` /
    // `secrets.<key>` / `ports.<key>` in CEL, so it lives in the same
    // identifier space as a resource name and breaks the same way. An
    // import's `variables:` / `secrets:` are deliberately NOT checked — those
    // keys are the imported library's declarations, so a violation there is
    // the library author's, reported when their module is analyzed as a root.
    if (manifest.kind === "Telo.Application" || manifest.kind === "Telo.Library") {
      for (const field of ["variables", "secrets", "ports"] as const) {
        const block = (manifest as Record<string, unknown>)[field];
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        for (const key of Object.keys(block as Record<string, unknown>)) {
          push(out, checkName(key, "value", `${singular(field)} name`), {
            kind: manifest.kind,
            name,
            filePath: metadata?.source as string | undefined,
            path: `${field}.${key}`,
          });
        }
      }
    }
  }

  for (const node of graph.nodes.values()) {
    if (node.type !== "step" || !node.name) continue;
    const owner = graph.nodes.get(node.owner);
    if (owner?.type !== "resource") continue;
    const ownerMeta = owner.manifest.metadata as Record<string, unknown> | undefined;
    if (ownerMeta?.xTeloOrigin) continue;
    const ownModule = ownerMeta?.module as string | undefined;
    if (ownModule && !rootModules.has(ownModule)) continue;

    push(out, checkName(node.name, "value", "step name"), {
      kind: owner.kind,
      name: owner.name,
      filePath: ownerMeta?.source as string | undefined,
      path: `${node.path}.name`,
    });
  }

  return out;
}

/**
 * A resource instance is value-level, EXCEPT when its capability is
 * `Telo.Type`: a named shape has no runtime instance, is referenced from
 * `inputType:` / `outputType:` type slots and resolves as
 * `telo:<module>/<Name>`, so its name denotes a type despite being declared as
 * a resource. Capability-driven rather than by kind name, so no resource kind
 * is hardcoded here.
 *
 * An unresolvable kind falls back to value level — the honest default, since
 * `UNDEFINED_KIND` already reports the real problem and guessing type level
 * would stack a case error on top of it.
 */
function levelFor(
  manifest: ResourceManifest,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
): NameLevel {
  if (TYPE_LEVEL_DOC_KINDS.has(manifest.kind as string)) return "type";
  // The root resolver is the right one unconditionally: every manifest
  // reaching here belongs to a root module, the others having been skipped.
  const canonical = aliases.resolveKind(manifest.kind as string) ?? (manifest.kind as string);
  return registry.resolve(canonical)?.capability === "Telo.Type" ? "type" : "value";
}

/** The noun phrase a diagnostic uses as its subject. */
function surfaceFor(kind: string): string {
  switch (kind) {
    case "Telo.Application":
    case "Telo.Library":
      return "module name";
    case "Telo.Definition":
    case "Telo.Abstract":
      return "kind name";
    case "Telo.Import":
      return "import alias";
    default:
      return "resource name";
  }
}

function singular(field: "variables" | "secrets" | "ports"): string {
  return field === "variables" ? "variable" : field === "secrets" ? "secret" : "port";
}

function push(
  out: AnalysisDiagnostic[],
  violation: NameViolation | undefined,
  at: { kind: string; name: string; filePath: string | undefined; path: string },
): void {
  if (!violation) return;
  out.push({
    severity: violation.severity,
    code: violation.code,
    source: SOURCE,
    message: `${at.kind}/${at.name}: ${violation.message}`,
    data: {
      resource: { kind: at.kind, name: at.name },
      filePath: at.filePath,
      path: at.path,
    },
  });
}
