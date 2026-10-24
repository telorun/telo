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
    for (const finding of declaredInputFindings(written, schema, defs, {
      subject: `Telo.Import/${alias}`,
      declarer: "the imported library",
    })) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: finding.code,
        source: SOURCE,
        message: finding.message,
        data: { resource, filePath, path: finding.path, ...(finding.fix ? { fix: finding.fix } : {}) },
      });
    }
  }
  return out;
}

/** One refusal of a supplied input, before it is anchored. */
export interface DeclaredInputFinding {
  code: string;
  message: string;
  /** Dotted path within `written`. */
  path: string;
  fix?: { replacement: string; tag: "module-path" };
}

/**
 * What is wrong with `written` — maps of supplied inputs keyed by block — against
 * `schema`, the declarations of whoever receives them. A literal is decoded
 * through its type's plain encoding first, and an expression stands in as its
 * slot's placeholder. `subject` begins each message and `declarer` names the
 * module the declarations are read from.
 */
export function declaredInputFindings(
  written: Record<string, unknown>,
  schema: Record<string, any>,
  defs: DefinitionRegistry,
  wording: { subject: string; declarer: string },
): DeclaredInputFinding[] {
  const out: DeclaredInputFinding[] = [];
  const { subject, declarer } = wording;
  const standIns: StandIns = new Map();
  const substituted = substituteDecodedCelFields(written, schema, undefined, {
    standIns,
    external: (ref) => defs.schemaForId(ref),
  });
  for (const issue of defs.validateResourceConfig(substituted, schema, standIns)) {
    const textRefusal = valueTypeRefusalCode(issue);
    if (textRefusal !== undefined) {
      out.push({ code: textRefusal, message: `${subject}: ${issue.message}`, path: issue.path });
      continue;
    }
    if (issue.valueType && VALUE_TYPES.get(issue.valueType)?.fromHost !== undefined) {
      const value = navigatePath(written, issue.path);
      if (isTaggedSentinel(value)) continue;
      out.push({
        code: "HOST_PATH_RELATIVE",
        message:
          `${subject}: ${issue.message}. ${capitalized(declarer)} resolves nothing it is ` +
          `given.${alsoAccepts(navigateSchemaToExprPath(schema, issue.path))}`,
        path: issue.path,
        ...(typeof value === "string" ? { fix: { replacement: value, tag: "module-path" as const } } : {}),
      });
      continue;
    }
    out.push({
      code: "SCHEMA_VIOLATION",
      message: `${subject}: ${issue.message} — ${declarer} declares it so.`,
      path: issue.path,
    });
  }
  return out;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function isEmptyBlock(value: unknown): boolean {
  return !value || typeof value !== "object" || Object.keys(value).length === 0;
}
