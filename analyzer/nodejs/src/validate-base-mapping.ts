import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { effectiveAuthorSchema, resolveParent, type DefResolver } from "./extends-resolution.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** True when a value subtree contains a CEL leaf — either a compiled CEL value
 *  (post-precompile) or the raw `!cel` tagged sentinel the analyzer sees at
 *  `telo check` time (this validator runs on the un-precompiled tree). Such a
 *  value can produce anything at runtime, so its type is not statically
 *  checkable. */
function containsCel(value: unknown): boolean {
  if (isCompiledValue(value)) return true;
  if (isTaggedSentinel(value) && value.engine === "cel") return true;
  if (Array.isArray(value)) return value.some(containsCel);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsCel);
  }
  return false;
}

/**
 * Phase 3c — Static validation of a definition's `base:` construction mapping
 * against the parent kind's config schema. The kernel evaluates `base:` and
 * passes the result to the inherited controller's `create()`, which validates it
 * at boot; this mirrors that check statically so an omitted required field or a
 * wrong literal type surfaces at `telo check`, not first boot.
 *
 * Diagnostics:
 *  - BASE_MISSING_REQUIRED: `base:` omits a field the parent schema requires.
 *  - BASE_UNKNOWN_FIELD: `base:` sets a field the parent schema (with
 *    `additionalProperties: false`) does not declare.
 *  - BASE_SCHEMA_MISMATCH: a CEL-free `base:` value violates the parent field's
 *    schema (wrong type / constraint). CEL-bearing values are skipped — their
 *    runtime value is unknown — but still count as present for required checks.
 */
export function validateBaseMapping(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const resolveDef: DefResolver = (k) =>
    registry.resolve(aliases.resolveKind(k) ?? k) ?? registry.resolve(k);

  const importedModules = new Set<string>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const resolved = (m.metadata as { resolvedModuleName?: string } | undefined)?.resolvedModuleName;
    if (resolved) importedModules.add(resolved);
  }

  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const base = (m as { base?: unknown }).base;
    if (!base || typeof base !== "object" || Array.isArray(base)) continue;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    const ownModule = (m.metadata as { module?: string } | undefined)?.module;
    if (ownModule && importedModules.has(ownModule)) continue;

    const parent = resolveParent(m as unknown as ResourceDefinition, resolveDef);
    // Missing / unresolved `extends` is already reported by validateExtends.
    if (!parent) continue;
    const parentSchema = effectiveAuthorSchema(parent, resolveDef);
    if (!parentSchema || typeof parentSchema !== "object") continue;

    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const resource = { kind: m.kind, name };
    const label = `${m.kind}/${name}`;
    checkObject(base as Record<string, unknown>, parentSchema, "base", {
      diagnostics,
      registry,
      label,
      resource,
      filePath,
    });
  }

  return diagnostics;
}

interface CheckCtx {
  diagnostics: AnalysisDiagnostic[];
  registry: DefinitionRegistry;
  label: string;
  resource: { kind: string; name: string };
  filePath: string | undefined;
}

function checkObject(
  value: Record<string, unknown>,
  schema: Record<string, any>,
  path: string,
  ctx: CheckCtx,
): void {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, any>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const additionalFalse = schema.additionalProperties === false;

  for (const req of required) {
    if (!(req in value)) {
      ctx.diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "BASE_MISSING_REQUIRED",
        source: SOURCE,
        message: `${ctx.label}: '${path}' does not set required parent field '${req}'.`,
        data: { resource: ctx.resource, filePath: ctx.filePath, path },
      });
    }
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    const fieldPath = `${path}.${key}`;
    const propSchema = properties[key];
    if (!propSchema) {
      if (additionalFalse) {
        ctx.diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "BASE_UNKNOWN_FIELD",
          source: SOURCE,
          message: `${ctx.label}: '${fieldPath}' is not a field of the parent kind's schema.`,
          data: { resource: ctx.resource, filePath: ctx.filePath, path: fieldPath },
        });
      }
      continue;
    }
    // A CEL-bearing value produces its shape at runtime — not statically
    // checkable. Recurse into a partially-CEL nested object so its literal
    // sub-fields still get validated; fully-literal values validate directly.
    if (containsCel(fieldValue)) {
      if (
        fieldValue &&
        typeof fieldValue === "object" &&
        !Array.isArray(fieldValue) &&
        !isCompiledValue(fieldValue) &&
        propSchema.type === "object" &&
        propSchema.properties
      ) {
        checkObject(fieldValue as Record<string, unknown>, propSchema, fieldPath, ctx);
      }
      continue;
    }
    const issues = ctx.registry.validateWithRefs(fieldValue, propSchema);
    for (const issue of issues) {
      ctx.diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "BASE_SCHEMA_MISMATCH",
        source: SOURCE,
        message: `${ctx.label}: '${fieldPath}' does not match the parent field's schema: ${issue}`,
        data: { resource: ctx.resource, filePath: ctx.filePath, path: fieldPath },
      });
    }
  }
}
