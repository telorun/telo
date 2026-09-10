import { nearestName } from "./nearest-name.js";
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { parseExportEntry } from "./flatten-for-analyzer.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * A LIBRARY'S EXPORT LIST IS CHECKED WHERE IT IS WRITTEN.
 *
 * `exports.kinds` and `exports.resources` are a library's public contract, and
 * they were read as a GATE only: a listed name resolved when a consumer asked
 * for it, and one that named nothing failed in the consumer's file
 * (`UNDEFINED_KIND` on `kind: L.Client`, with nothing wrong in that file) while
 * the author who could fix it saw a clean check. Both entries are resolved here,
 * against what the library declares:
 *
 *  - a bare kind names a `Telo.Definition` / `Telo.Abstract` of this module, and
 *    `Alias.Kind` re-exports through an import declared in this file
 *    (`EXPORT_KIND_UNKNOWN`). The one mistake that reads as intended — a bare
 *    name that IS a kind, of an imported module — gets the re-export spelling
 *    in its message, because a clean check was read as confirmation it worked;
 *  - a bare instance names a resource declared in this module, and
 *    `Alias.name` an instance the aliased import exports
 *    (`EXPORT_RESOURCE_UNKNOWN`).
 *
 * Runs on the library as an ENTRY — a consumer's flattened analysis drops the
 * library doc, and the list is not the consumer's to fix. Browser-safe.
 */
export function validateExports(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];

  for (const lib of manifests) {
    if (lib.kind !== "Telo.Library") continue;
    const moduleName = lib.metadata?.name as string | undefined;
    if (!moduleName || !rootModules.has(moduleName)) continue;
    const exports = (lib as { exports?: { kinds?: unknown; resources?: unknown } }).exports;
    if (!exports || typeof exports !== "object") continue;
    const filePath = (lib.metadata as { source?: string } | undefined)?.source;
    const resource = { kind: lib.kind, name: moduleName };

    const own = (m: ResourceManifest): boolean => {
      const mod = (m.metadata as { module?: string } | undefined)?.module;
      return mod === undefined || mod === moduleName;
    };
    const declaredKinds = new Set<string>();
    const instances = new Set<string>();
    const importAliases = new Map<string, string | undefined>();
    const forwardedByModule = new Map<string, Set<string>>();
    for (const m of manifests) {
      const name = m.metadata?.name;
      if (typeof name !== "string") continue;
      const meta = m.metadata as {
        module?: string;
        forwardedExport?: boolean;
        resolvedModuleName?: string;
      };
      if (meta.forwardedExport && meta.module) {
        let set = forwardedByModule.get(meta.module);
        if (!set) forwardedByModule.set(meta.module, (set = new Set()));
        set.add(name);
        continue;
      }
      if (!own(m)) continue;
      if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") declaredKinds.add(name);
      else if (m.kind === "Telo.Import") importAliases.set(name, meta.resolvedModuleName);
      else if (m.kind !== "Telo.Library" && m.kind !== "Telo.Application") instances.add(name);
    }

    const report = (code: string, path: string, message: string, fix?: string) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: SOURCE,
        message: `Telo.Library/${moduleName}: ${message}`,
        data: { resource, filePath, path, ...(fix ? { fix: { replacement: fix } } : {}) },
      });

    const kinds = exports.kinds;
    if (Array.isArray(kinds)) {
      kinds.forEach((entry, i) => {
        if (typeof entry !== "string") return;
        const path = `exports.kinds[${i}]`;
        const { alias, name } = parseExportEntry(entry);
        if (alias) {
          if (!importAliases.has(alias)) {
            report(
              "EXPORT_KIND_UNKNOWN",
              path,
              `'exports.kinds: ${entry}' re-exports through '${alias}', which is not an import ` +
                `of this library. Imports: ${[...importAliases.keys()].join(", ") || "(none)"}.`,
            );
            return;
          }
          const canonical = aliases.resolveKind(entry);
          if (canonical && !registry.resolve(canonical)) {
            report(
              "EXPORT_KIND_UNKNOWN",
              path,
              `'exports.kinds: ${entry}' names no kind '${name}' exported by '${alias}'.`,
            );
          }
          return;
        }
        if (declaredKinds.has(name)) return;
        // The natural first attempt at a re-export: the imported kind's bare
        // suffix. It resolves as a kind — just not as one this library owns.
        const viaImport = [...importAliases.keys()].find((a) => {
          const canonical = aliases.resolveKind(`${a}.${name}`);
          return canonical !== undefined && registry.resolve(canonical) !== undefined;
        });
        if (viaImport) {
          report(
            "EXPORT_KIND_UNKNOWN",
            path,
            `'exports.kinds: ${name}' is not a kind this library declares — it is ` +
              `'${viaImport}.${name}', an imported kind. Re-export it as '${viaImport}.${name}', ` +
              `or declare a local kind that extends it.`,
            `${viaImport}.${name}`,
          );
          return;
        }
        const suggestion = nearestName(name, [...declaredKinds]);
        report(
          "EXPORT_KIND_UNKNOWN",
          path,
          `'exports.kinds: ${name}' names no Telo.Definition or Telo.Abstract of this library. ` +
            `Declared: ${[...declaredKinds].join(", ") || "(none)"}.` +
            (suggestion ? ` Did you mean '${suggestion}'?` : ""),
          suggestion,
        );
      });
    }

    const resources = exports.resources;
    if (Array.isArray(resources)) {
      resources.forEach((entry, i) => {
        if (typeof entry !== "string") return;
        const path = `exports.resources[${i}]`;
        const { alias, name } = parseExportEntry(entry);
        if (alias) {
          if (!importAliases.has(alias)) {
            report(
              "EXPORT_RESOURCE_UNKNOWN",
              path,
              `'exports.resources: ${entry}' re-exports through '${alias}', which is not an ` +
                `import of this library. Imports: ${[...importAliases.keys()].join(", ") || "(none)"}.`,
            );
            return;
          }
          const targetModule = importAliases.get(alias);
          const exported = targetModule ? forwardedByModule.get(targetModule) : undefined;
          if (exported && !exported.has(name)) {
            report(
              "EXPORT_RESOURCE_UNKNOWN",
              path,
              `'exports.resources: ${entry}' names no instance '${name}' exported by '${alias}'. ` +
                `Exported: ${[...exported].join(", ") || "(none)"}.`,
            );
          }
          return;
        }
        if (instances.has(name)) return;
        const suggestion = nearestName(name, [...instances]);
        report(
          "EXPORT_RESOURCE_UNKNOWN",
          path,
          `'exports.resources: ${name}' names no resource declared in this library. ` +
            `Declared: ${[...instances].join(", ") || "(none)"}.` +
            (suggestion ? ` Did you mean '${suggestion}'?` : ""),
          suggestion,
        );
      });
    }
  }

  return out;
}
