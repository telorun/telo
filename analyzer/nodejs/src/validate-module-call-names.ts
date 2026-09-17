/**
 * **An import alias that a kind has already put in CEL scope.**
 *
 * A module's `imports:` keys are the names a CEL call resolves a MODULE through:
 * `Billing.format(x)` calls the function `Billing` names. A kind's
 * `x-telo-context` can declare a variable of the same name — and where both
 * hold, the call resolves to the module and the context variable is unreachable
 * through one, silently.
 *
 * Reported at the `imports:` key, not at the kind: the kind's author declared a
 * context long before this consumer existed, cannot know the aliases their
 * consumers will choose, and a published dependency's file is not the
 * consumer's to change. Renaming the alias is the one repair, and it is the
 * consumer's to make — so the diagnostic lands on the line that holds it.
 *
 * Scoped to the entry's own modules for the same reason, and only for a kind
 * some resource of that module actually declares: a context in a kind nothing
 * uses puts nothing in scope.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { definitionInScope } from "./module-alias-scope.js";
import { declaringModuleKey, ROOT_MODULE_KEY } from "./module-call-names.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { extractContextsFromSchema } from "./validate-cel-context.js";

const SOURCE = "telo-analyzer";

export function validateModuleCallNames(
  manifests: readonly ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: ReadonlyMap<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  // The import declarations of the entry's own modules, by module and alias.
  // Only these can be renamed by the author reading the diagnostic.
  const importsByModule = new Map<string, Map<string, ResourceManifest>>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const alias = m.metadata?.name;
    if (typeof alias !== "string" || !alias) continue;
    const module = declaringModuleKey(m);
    if (module !== ROOT_MODULE_KEY && !rootModules.has(module)) continue;
    const byAlias = importsByModule.get(module) ?? new Map<string, ResourceManifest>();
    byAlias.set(alias, m);
    importsByModule.set(module, byAlias);
  }
  if (importsByModule.size === 0) return [];

  const out: AnalysisDiagnostic[] = [];
  // One diagnostic per (module, alias): the same collision seen through ten
  // resources of one kind is one fact about the pair.
  const reported = new Map<string, Set<string>>();
  const contextNames = new Map<object, readonly string[]>();

  for (const m of manifests) {
    if (typeof m.kind !== "string") continue;
    const module = declaringModuleKey(m);
    const byAlias = importsByModule.get(module);
    if (!byAlias) continue;
    const definition = definitionInScope<ResourceDefinition>(
      registry,
      m.kind,
      m.metadata,
      aliases,
      aliasesByModule,
    );
    const schema = (definition as { schema?: unknown } | undefined)?.schema;
    if (!schema || typeof schema !== "object") continue;

    let names = contextNames.get(schema as object);
    if (!names) {
      const collected = new Set<string>();
      for (const { schema: context } of extractContextsFromSchema(
        schema as Record<string, any>,
      )) {
        for (const name of Object.keys(context.properties ?? {})) collected.add(name);
      }
      contextNames.set(schema as object, (names = [...collected]));
    }

    for (const name of names) {
      const declaration = byAlias.get(name);
      if (!declaration) continue;
      const seen = reported.get(module) ?? new Set<string>();
      if (seen.has(name)) continue;
      seen.add(name);
      reported.set(module, seen);
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "IMPORT_ALIAS_SHADOWS_CONTEXT",
        source: SOURCE,
        message:
          `Import alias '${name}' is also a CEL variable ${m.kind} puts in scope. A call ` +
          `written '${name}.f(…)' resolves to the imported module, so the variable cannot be ` +
          `reached through one. Rename the alias.`,
        data: {
          resource: { kind: "Telo.Import", name },
          filePath: (declaration.metadata as { source?: string } | undefined)?.source,
          path: "metadata.name",
        },
      });
    }
  }

  return out;
}
