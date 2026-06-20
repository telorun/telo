import type { ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";
const SCHEMA_FIELDS = ["schema", "inputType", "outputType"] as const;

/**
 * Validates module-scoped schema `$ref`s of the form `telo://<authority>/<type>`.
 * The authority is an import alias (or `Self`) declared in the resource's module;
 * the type must be a registered `Telo.Type` resource in the module it resolves to.
 *
 * Diagnostics (both errors — a `$ref` that resolves to nothing is never validated
 * by AJV, so without this it would silently pass):
 *  - SCHEMA_TYPE_REF_UNKNOWN_ALIAS: the authority is neither `Self` nor a declared import.
 *  - SCHEMA_TYPE_REF_UNRESOLVED: the authority resolves to a module, but that module
 *    declares no `Telo.Type` named `<type>`.
 *
 * Forwarded/imported definitions are skipped — their own refs are validated when the
 * owning library is analyzed as a root, and the consumer's scope can't see the
 * library's internal aliases (mirrors `validateExtends`).
 */
export function validateSchemaTypeRefs(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: Set<string>,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const m of manifests) {
    const ownModule = (m.metadata as { module?: string } | undefined)?.module;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    // Only validate refs authored in a root module's scope; imported defs are
    // validated against their own library when it's analyzed as a root.
    if (ownModule && !rootModules.has(ownModule)) continue;
    const resolver = (ownModule ? aliasesByModule.get(ownModule) : undefined) ?? aliases;
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const label = `${m.kind}/${name}`;

    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      const obj = value as Record<string, unknown>;
      const parsed = parseTeloTypeRef(obj.$ref);
      if (parsed) {
        const module = parsed.authority === "Self" ? ownModule : resolver.moduleForAlias(parsed.authority);
        if (!module) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_TYPE_REF_UNKNOWN_ALIAS",
            source: SOURCE,
            message:
              `${label}: schema $ref '${obj.$ref}' — '${parsed.authority}' is not 'Self' or a ` +
              `Telo.Import in this module. Declare the import or correct the authority.`,
            data: { resource: { kind: m.kind, name }, filePath, path: `${path}/$ref` },
          });
        } else if (!registry.hasSchemaId(canonicalTypeSchemaId(module, parsed.typeName))) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_TYPE_REF_UNRESOLVED",
            source: SOURCE,
            message:
              `${label}: schema $ref '${obj.$ref}' resolves to module '${module}', which declares ` +
              `no Telo.Type named '${parsed.typeName}'.`,
            data: { resource: { kind: m.kind, name }, filePath, path: `${path}/$ref` },
          });
        }
      }
      for (const key of Object.keys(obj)) walk(obj[key], `${path}/${key}`);
    };

    for (const field of SCHEMA_FIELDS) {
      walk((m as Record<string, unknown>)[field], field);
    }
  }

  return diagnostics;
}
