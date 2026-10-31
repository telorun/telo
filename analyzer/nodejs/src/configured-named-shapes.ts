import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { declaringModuleScope, definitionInScope } from "./module-alias-scope.js";
import { foldedNamedShapes, type NamedShapeDeclaration } from "./named-shape-extends.js";
import type { ModuleDocuments } from "./module-documents.js";
import { canonicalShapeSchema, withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";

/** What reading the named shapes of one configuration needs of its scope. */
export interface ConfiguredShapeScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: Set<string>;
}

/** Whether `m` declares a named shape: a resource whose kind's capability is
 *  `Telo.Type`. */
export function declaresNamedShape(m: ResourceManifest, scope: ConfiguredShapeScope): boolean {
  if (typeof m.kind !== "string") return false;
  return (
    definitionInScope(scope.defs, m.kind, m.metadata, scope.aliases, scope.aliasesByModule)?.capability === "Telo.Type"
  );
}

/**
 * The named shapes one configuration holds, as that configuration holds them:
 * each declaration (already projected to the configuration) canonical in its
 * declaring module, its `extends` parents folded, `libraries`' shapes beside.
 * The one function behind both a witness's shapes in the analysis and a
 * running configuration's view (`AnalysisRegistry.forConfiguration`).
 */
export function configuredNamedShapes(
  declarations: Iterable<ResourceManifest>,
  scope: ConfiguredShapeScope,
  libraries: readonly NamedShapeDeclaration[],
): (module: string, name: string) => Record<string, any> | undefined {
  const declared: NamedShapeDeclaration[] = [];
  for (const m of declarations) {
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    const name = m.metadata?.name;
    if (typeof module !== "string" || typeof name !== "string") continue;
    if (!m.schema || typeof m.schema !== "object") continue;
    const moduleScope = declaringModuleScope(module, scope.aliases, scope);
    const moduleForAlias = (alias: string) => moduleScope.moduleForAlias(alias);
    declared.push({
      module,
      name,
      extends: (m as { extends?: unknown }).extends,
      schema: canonicalShapeSchema(
        withCanonicalRefSentinels(m.schema, module, moduleForAlias) as Record<string, any>,
        module,
        moduleForAlias,
      ),
    });
  }
  return foldedNamedShapes([...declared, ...libraries]);
}

/**
 * Each imported library's own named shapes, read from its full documents: a
 * shape's `extends` may name one no forwarded declaration reaches, and the
 * kernel folds it all the same. Each `!ref` a schema holds is made canonical in
 * its library's scope, once, when a fold first reads it.
 */
export function libraryNamedShapes(
  options: { moduleDocuments?: readonly ModuleDocuments[] } | undefined,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: Set<string>,
): NamedShapeDeclaration[] {
  const out: NamedShapeDeclaration[] = [];
  for (const library of options?.moduleDocuments ?? []) {
    const scope = declaringModuleScope(library.module, aliases, { aliasesByModule, rootModules });
    for (const doc of library.manifests) {
      const name = doc.metadata?.name;
      if (typeof name !== "string" || typeof doc.kind !== "string") continue;
      if (!doc.schema || typeof doc.schema !== "object") continue;
      if (defs.resolve(scope.resolveKind(doc.kind) ?? doc.kind)?.capability !== "Telo.Type") continue;
      let canonical: Record<string, any> | undefined;
      out.push({
        module: library.module,
        name,
        extends: (doc as { extends?: unknown }).extends,
        get schema() {
          canonical ??= withCanonicalRefSentinels(doc.schema, library.module, (alias) =>
            scope.moduleForAlias(alias),
          ) as Record<string, any>;
          return canonical;
        },
      });
    }
  }
  return out;
}
