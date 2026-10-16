import type { ResourceManifest } from "@telorun/sdk";
import { VALUE_TYPES } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import type { DefinitionRegistry } from "./definition-registry.js";
import { alsoAccepts } from "./host-path-slot.js";
import { importInputsSchema } from "./import-inputs.js";
import type { ModuleDocuments } from "./module-documents.js";
import { navigatePath } from "./peer-binding.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import { navigateSchemaToExprPath } from "./schema-compat.js";
import { valueTypeRefusalCode } from "./schema-error-report.js";
import type { StandIns } from "./stand-in-findings.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * What an import writes under `variables:` / `secrets:`, held to the entries the library
 * declares — the static twin of the import controller, which decodes, builds and
 * validates the same supply when the import initializes.
 *
 * A literal is decoded through its type's plain encoding first, exactly as the kernel
 * reads it, and an expression stands in as its slot's placeholder (its type is the CEL
 * join's). Each finding takes the code the same readers choose at a resource's own field:
 * a type admitting text its own (`URL_INVALID`), a relative literal at a host path
 * `HOST_PATH_RELATIVE` with its `!module-path` repair, anything else `SCHEMA_VIOLATION`.
 * A tag at a host path is the import host-path pass's `HOST_PATH_UNTYPED_SOURCE`, so it is
 * not reported here.
 *
 * Entry-module-scoped: an import inside a dependency is its author's to fix.
 */
export function validateImportInputs(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  documents: readonly ModuleDocuments[],
  defs: DefinitionRegistry,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Import") continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.module === "string" && !rootModules.has(metadata.module)) continue;
    const written = {
      variables: (manifest as Record<string, unknown>).variables ?? {},
      secrets: (manifest as Record<string, unknown>).secrets ?? {},
    };
    if (isEmptyBlock(written.variables) && isEmptyBlock(written.secrets)) continue;
    const schema = importInputsSchema(manifest, documents);
    if (!schema) continue;

    const alias = String(metadata.name ?? "");
    const resource = { kind: manifest.kind, name: alias };
    const filePath = typeof metadata.source === "string" ? metadata.source : undefined;
    const standIns: StandIns = new Map();
    const substituted = substituteDecodedCelFields(written, schema, undefined, {
      standIns,
      external: (ref) => defs.schemaForId(ref),
    });
    for (const issue of defs.validateResourceConfig(substituted, schema, standIns)) {
      const data = { resource, filePath, path: issue.path };
      const textRefusal = valueTypeRefusalCode(issue);
      if (textRefusal !== undefined) {
        out.push({
          severity: DiagnosticSeverity.Error,
          code: textRefusal,
          source: SOURCE,
          message: `Telo.Import/${alias}: ${issue.message}`,
          data,
        });
        continue;
      }
      if (issue.valueType && VALUE_TYPES.get(issue.valueType)?.fromHost !== undefined) {
        const value = navigatePath(written, issue.path);
        if (isTaggedSentinel(value)) continue;
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "HOST_PATH_RELATIVE",
          source: SOURCE,
          message:
            `Telo.Import/${alias}: ${issue.message}. The imported library resolves nothing it is ` +
            `given.${alsoAccepts(navigateSchemaToExprPath(schema, issue.path))}`,
          data: {
            ...data,
            ...(typeof value === "string" ? { fix: { replacement: value, tag: "module-path" as const } } : {}),
          },
        });
        continue;
      }
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "SCHEMA_VIOLATION",
        source: SOURCE,
        message: `Telo.Import/${alias}: ${issue.message} — the imported library declares it so.`,
        data,
      });
    }
  }
  return out;
}

function isEmptyBlock(value: unknown): boolean {
  return !value || typeof value !== "object" || Object.keys(value).length === 0;
}
