/**
 * The diagnostics of the `x-telo-type` and `x-telo-schema-projection-from`
 * annotations a declaration writes, which a plain analysis reports with the
 * declaration and a keyed one once per key of its own region.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import type { SchemaProjectionIssue } from "./validate-schema-projection.js";
import { validateSchemaProjection } from "./validate-schema-projection.js";
import { validateValueTypeSlots, type ValueTypeSlotIssue } from "./validate-value-type-slots.js";

const SOURCE = "telo-analyzer";

export function valueTypeSlotDiagnostic(issue: ValueTypeSlotIssue): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    code: issue.code,
    source: SOURCE,
    message: issue.message,
    data: {
      resource: { kind: issue.manifest.kind, name: issue.manifest.metadata?.name as string },
      filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
      path: issue.path,
      ...(issue.fix ? { fix: issue.fix } : {}),
    },
  };
}

export function schemaProjectionDiagnostic(issue: SchemaProjectionIssue): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    code: issue.code,
    source: SOURCE,
    message: issue.message,
    data: {
      resource: { kind: issue.manifest.kind, name: issue.manifest.metadata?.name as string },
      filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
      path: issue.path,
    },
  };
}

/** Every `x-telo-type` and projection finding of one declaration. */
export function schemaAnnotationFindings(declaration: ResourceManifest): AnalysisDiagnostic[] {
  return [
    ...validateValueTypeSlots(declaration).map(valueTypeSlotDiagnostic),
    ...validateSchemaProjection(declaration).map(schemaProjectionDiagnostic),
  ];
}

/** `value` copied through its arrays and plain objects, anything else kept: what a
 *  reader that canonicalizes in place may be given without touching the original. */
export function copiedPlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copiedPlain) as T;
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, copiedPlain(member)])) as T;
}
