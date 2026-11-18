import type { ResourceManifest } from "@telorun/sdk";
import { expansionTagLabel } from "@telorun/templating";
import type { Holding } from "./conditioned-expansion.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import type { ScopedImportIndex } from "./scoped-import-index.js";
import { scopesDeclaredBy } from "./scope-members.js";
import { pathText } from "./template-expansion.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * `DUPLICATE_RESOURCE_NAME` for a `Telo.Import` declared as a scope member that
 * names its scope's instance names like one of its module's `imports:` aliases
 * or the module's own name — a `!ref <Member>.<name>` inside the scope would
 * read one and mean the other. Read off the scoped imports as written
 * (`scoped-import-index.ts`): one finding per scoped import of the entry's own
 * modules, held where the import is present and reported where it is written.
 * `importAliases` names the aliases a module's own `imports:` declare.
 */
export function scopedImportAliasCollisions(
  index: ScopedImportIndex,
  importAliases: (module: string) => ReadonlySet<string>,
  rootModules: ReadonlySet<string>,
): { readonly diagnostic: AnalysisDiagnostic; readonly holding: Holding }[] {
  const out: { diagnostic: AnalysisDiagnostic; holding: Holding }[] = [];
  for (const [module, byAlias] of index) {
    if (!rootModules.has(module)) continue;
    const aliases = importAliases(module);
    for (const [alias, entries] of byAlias) {
      const collides = aliases.has(alias) ? `the import aliased '${alias}'` : alias === module ? `this module's own name` : undefined;
      if (!collides) continue;
      for (const { place, holding, written } of entries) {
        const meta = written.root.metadata as { name?: unknown; source?: unknown } | undefined;
        out.push({
          diagnostic: {
            severity: DiagnosticSeverity.Error,
            code: "DUPLICATE_RESOURCE_NAME",
            source: SOURCE,
            message:
              `Telo.Import/${place.alias}: the import declared in the \`${place.field}:\` scope of ` +
              `'${place.holder}' is named like ${collides} of module '${module}', so ` +
              `\`!ref ${place.alias}.<name>\` inside that scope would read one and mean the other. ` +
              `Rename the scoped import.`,
            data: {
              ...(typeof meta?.source === "string" ? { filePath: meta.source } : {}),
              resource: { kind: written.root.kind ?? expansionTagLabel(written.root), name: typeof meta?.name === "string" ? meta.name : "" },
              path: pathText([...written.keys, "metadata", "name"]),
            },
          },
          holding,
        });
      }
    }
  }
  return out;
}

/** The aliases each module's own `Telo.Import` documents declare, read off
 *  `manifests`. */
export function moduleImportAliases(manifests: readonly ResourceManifest[]): (module: string) => ReadonlySet<string> {
  const byModule = new Map<string, Set<string>>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import" || isForwardedDeclaration(m)) continue;
    const module = (m.metadata as { module?: string } | undefined)?.module;
    const alias = m.metadata?.name;
    if (typeof module !== "string" || typeof alias !== "string") continue;
    const aliases = byModule.get(module) ?? new Set<string>();
    aliases.add(alias);
    byModule.set(module, aliases);
  }
  return (module) => byModule.get(module) ?? new Set();
}

/**
 * `DUPLICATE_RESOURCE_NAME` for a member named like a member of another scope
 * array of the same holder, since a scoped import's instance path names it by
 * holder and name alone. Reported at the later member, for the entry's own
 * modules.
 */
export function scopeArrayNameCollisions(holder: ResourceManifest, rootModules: ReadonlySet<string>): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const scopes = scopesDeclaredBy(holder);
  if (scopes.length < 2) return out;
  const module = (holder.metadata as { module?: string } | undefined)?.module;
  if (!module || !rootModules.has(module) || isModuleKind(holder.kind)) return out;
  const seen = new Map<string, string>();
  for (const scope of scopes) {
    scope.declarations.forEach((entry, index) => {
      const name = (entry as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
      if (typeof name !== "string") return;
      const first = seen.get(name);
      if (first === undefined) {
        seen.set(name, scope.path);
        return;
      }
      if (first === scope.path) return;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "DUPLICATE_RESOURCE_NAME",
        source: SOURCE,
        message:
          `${holder.kind}/${holder.metadata?.name as string}: '${name}' is declared in its ` +
          `\`${first}:\` scope and again in its \`${scope.path}:\` scope; a member is named by its ` +
          `holder and its name, so the two cannot be told apart. Rename one of them.`,
        data: {
          filePath: (holder.metadata as { source?: string } | undefined)?.source,
          resource: { kind: holder.kind, name: holder.metadata?.name as string },
          path: `${scope.path}[${index}].metadata.name`,
        },
      });
    });
  }
  return out;
}
