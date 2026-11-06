import type { ResourceManifest } from "@telorun/sdk";
import { scopedImportAnchorOf, scopedImportMembers } from "./flatten-for-analyzer.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import { scopedImportPlace } from "./scoped-import-identity.js";
import { scopesDeclaredBy } from "./scope-members.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * `DUPLICATE_RESOURCE_NAME` for a `Telo.Import` declared as a scope member that
 * names its scope's instance names like one of its module's `imports:` aliases
 * or the module's own name — a `!ref <Member>.<name>` inside the scope would
 * read one and mean the other — and for a member named like a member of another
 * scope array of the same holder, since a scoped import's instance path names
 * it by holder and name alone. Reported at the later member, for the entry's
 * own modules.
 */
export function scopedImportNameCollisions(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const moduleNames = new Map<string, Map<string, string>>();
  const namesOf = (module: string): Map<string, string> => {
    let names = moduleNames.get(module);
    if (names) return names;
    names = new Map([[module, `this module's own name`]]);
    for (const m of manifests) {
      if (m.kind !== "Telo.Import" || isForwardedDeclaration(m)) continue;
      if ((m.metadata as { module?: string } | undefined)?.module !== module) continue;
      const alias = m.metadata?.name;
      if (typeof alias === "string") names.set(alias, `the import aliased '${alias}'`);
    }
    moduleNames.set(module, names);
    return names;
  };
  for (const { member, top } of scopedImportMembers(manifests)) {
    const module = (top.metadata as { module?: string } | undefined)?.module;
    const place = scopedImportPlace(member);
    const anchor = scopedImportAnchorOf(member);
    if (!module || !rootModules.has(module) || !place || !anchor) continue;
    const collides = namesOf(module).get(place.alias);
    if (!collides) continue;
    out.push({
      severity: DiagnosticSeverity.Error,
      code: "DUPLICATE_RESOURCE_NAME",
      source: SOURCE,
      message:
        `Telo.Import/${place.alias}: the import declared in the \`${place.field}:\` scope of ` +
        `'${place.holder}' is named like ${collides} of module '${module}', so ` +
        `\`!ref ${place.alias}.<name>\` inside that scope would read one and mean the other. ` +
        `Rename the scoped import.`,
      data: { filePath: anchor.filePath, resource: anchor.resource, path: `${anchor.path}.metadata.name` },
    });
  }
  // A name shared by members of two scope arrays of one holder.
  for (const holder of manifests) {
    const scopes = scopesDeclaredBy(holder);
    if (scopes.length < 2) continue;
    const module = (holder.metadata as { module?: string } | undefined)?.module;
    if (!module || !rootModules.has(module) || isModuleKind(holder.kind)) continue;
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
  }
  return out;
}
