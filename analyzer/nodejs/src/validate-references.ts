import type { ResourceManifest } from "@telorun/sdk";
import { isRefEntry, isScopeEntry, isSchemaFromEntry, isInlineResource, resolveFieldValues, type RefFieldEntry } from "./reference-field-map.js";
import { navigateJsonPointer } from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisContext } from "./types.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";

const SOURCE = "telo-analyzer";
/** Kinds skipped by reference validation. Kernel.Application and Kernel.Library
 *  are intentionally not here: Application has `targets` with x-telo-ref that
 *  must be validated, and Library has no ref-bearing fields so flows through
 *  harmlessly. Kernel.Import is also not here for the same reason — its
 *  `source` field isn't x-telo-ref, so nothing gets checked. */
const SYSTEM_KINDS = new Set(["Kernel.Definition", "Kernel.Abstract"]);

/**
 * Checks whether `kind` satisfies the ref constraint in `entry`.
 * Returns an empty array when valid, or mismatch error strings when not.
 * Returns an empty array immediately when the ref identity is not registered
 * (partial context — skip check rather than false-positive).
 */
function checkKind(
  kind: string,
  entry: RefFieldEntry,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
): string[] {
  const resolved = aliases.resolveKind(kind) ?? kind;
  const errors: string[] = [];
  for (const refStr of entry.refs) {
    const targetKind = registry.resolveRef(refStr);
    if (!targetKind) return [];
    const targetDef = registry.resolve(targetKind);
    if (!targetDef) return [];
    if (targetDef.kind === "Kernel.Abstract") {
      const implementing = registry.getByExtends(targetKind);
      if (implementing.length === 0) return []; // partial context — no implementations loaded yet
      const implementingKinds = new Set(
        implementing.map((d) => `${d.metadata.module}.${d.metadata.name}`),
      );
      if (implementingKinds.has(resolved)) return [];
      const options = [...implementingKinds].join(", ");
      errors.push(
        `'${kind}' does not implement '${targetKind}' (known implementations: ${options})`,
      );
    } else {
      if (resolved === targetKind) return [];
      errors.push(`'${kind}' (resolved: '${resolved}') does not match required '${targetKind}'`);
    }
  }
  return errors;
}

/**
 * Phase 3 — Reference validation.
 *
 * For each x-telo-ref slot in every non-system resource, validates:
 *   1. Structural — the value has string `kind` and `name` fields.
 *   2. Kind — the alias-resolved kind satisfies the x-telo-ref constraint
 *             (abstract: must extend the target; concrete: must equal it exactly).
 *   3. Resolution — a resource with that name exists in the visible manifest set
 *                   (outer manifests + scope manifests for in-scope ref paths).
 *
 * Ref values with keys beyond kind/name/metadata are treated as inline resources
 * pending Phase 2 normalization and are skipped without error.
 *
 * Returns an empty array when `context.aliases` or `context.definitions` is absent.
 */
export function validateReferences(
  resources: ResourceManifest[],
  context: AnalysisContext,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const aliases = context.aliases;
  const registry = context.definitions;
  if (!aliases || !registry) return diagnostics;

  // Build outer resource lookup by name for resolution check.
  // Exclude system kinds (Kernel.Definition) — they are type blueprints, not instances,
  // and their names (e.g. "Server", "Job") would shadow user-defined resource instances.
  const byName = new Map<string, ResourceManifest>();
  for (const r of resources) {
    if (r.metadata?.name && !SYSTEM_KINDS.has(r.kind)) byName.set(r.metadata.name as string, r);
  }

  for (const r of resources) {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;

    const fieldMap = registry.getFieldMapForKind(r.kind, aliases);
    if (!fieldMap) continue;

    const resourceLabel = `${r.kind}/${r.metadata.name as string}`;
    const resourceData = { kind: r.kind, name: r.metadata.name as string };

    // Collect scope visibility prefixes (JSON Pointer → dot prefix) and their manifests.
    // scope field path → flat array of ResourceManifest declared in that scope.
    const scopeManifestsByPointer = new Map<string, ResourceManifest[]>();
    for (const [fieldPath, entry] of fieldMap) {
      if (!isScopeEntry(entry)) continue;
      const raw = resolveFieldValues(r, fieldPath)
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .filter((v): v is ResourceManifest => !!v && typeof v === "object");
      const pointers = Array.isArray(entry.scope) ? entry.scope : [entry.scope];
      for (const pointer of pointers) {
        scopeManifestsByPointer.set(pointer, raw);
      }
    }

    const scopePrefixes = Array.from(scopeManifestsByPointer.keys()).map((p) =>
      p.replace(/^\//, "").replace(/\//g, "."),
    );

    for (const [fieldPath, entry] of fieldMap) {
      if (!isRefEntry(entry)) continue;

      const inScope = scopePrefixes.some(
        (prefix) =>
          fieldPath === prefix ||
          fieldPath.startsWith(prefix + ".") ||
          fieldPath.startsWith(prefix + "["),
      );

      // Scope manifests visible to this ref path.
      const visibleScopeManifests: ResourceManifest[] = [];
      if (inScope) {
        for (const [pointer, manifests] of scopeManifestsByPointer) {
          const prefix = pointer.replace(/^\//, "").replace(/\//g, ".");
          if (
            fieldPath === prefix ||
            fieldPath.startsWith(prefix + ".") ||
            fieldPath.startsWith(prefix + "[")
          ) {
            visibleScopeManifests.push(...manifests);
          }
        }
      }

      for (const val of resolveFieldValues(r, fieldPath)) {
        if (!val) continue;

        // Name-only reference (plain string) — look up by name to validate.
        // Qualified references use "Kind.Name" format (e.g. "Http.Api.PaymentApi");
        // extract the resource name from the last dot segment.
        if (typeof val === "string") {
          const lastDot = val.lastIndexOf(".");
          const refName = lastDot > 0 ? val.slice(lastDot + 1) : val;
          const refKindPrefix = lastDot > 0 ? val.slice(0, lastDot) : undefined;
          const target =
            byName.get(refName) ?? visibleScopeManifests.find((m) => m.metadata?.name === refName);
          if (!target) {
            // Cross-module reference: "Alias.ResourceName" (single dot, bare alias prefix).
            // The resource lives in the imported module's scope and can't be validated here.
            // Multi-dot prefixes like "Alias.Kind.Name" are local resources with qualified
            // kinds — those must be validated.
            if (refKindPrefix && !refKindPrefix.includes(".") && aliases.hasAlias(refKindPrefix)) {
              continue;
            }
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "UNRESOLVED_REFERENCE",
              source: SOURCE,
              message: `${resourceLabel}: reference at '${fieldPath}' → resource '${val}' not found`,
              data: { resource: resourceData, path: fieldPath },
            });
            continue;
          }
          const kindErrors = checkKind(target.kind as string, entry, registry, aliases);
          if (kindErrors.length > 0) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "REFERENCE_KIND_MISMATCH",
              source: SOURCE,
              message: `${resourceLabel}: reference at '${fieldPath}' → ${kindErrors.join("; ")}`,
              data: { resource: resourceData, path: fieldPath },
            });
          }
          continue;
        }

        if (typeof val !== "object") continue;
        const refVal = val as Record<string, unknown>;

        // Skip inline resources — Phase 2 normalization hasn't run yet.
        if (isInlineResource(refVal)) continue;

        // 1. Structural check
        if (typeof refVal.kind !== "string" || typeof refVal.name !== "string") {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "INVALID_REFERENCE",
            source: SOURCE,
            message: `${resourceLabel}: reference at '${fieldPath}' must have string 'kind' and 'name' fields`,
            data: { resource: resourceData, path: fieldPath },
          });
          continue;
        }

        // 2. Kind check
        const kindErrors = checkKind(refVal.kind, entry, registry, aliases);
        if (kindErrors.length > 0) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "REFERENCE_KIND_MISMATCH",
            source: SOURCE,
            message: `${resourceLabel}: reference at '${fieldPath}' → ${kindErrors.join("; ")}`,
            data: { resource: resourceData, path: fieldPath },
          });
        }

        // 3. Resolution check — resource with this name must exist.
        const exists =
          byName.has(refVal.name) ||
          visibleScopeManifests.some((m) => m.metadata?.name === refVal.name);
        if (!exists) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "UNRESOLVED_REFERENCE",
            source: SOURCE,
            message: `${resourceLabel}: reference at '${fieldPath}' → resource '${refVal.name}' not found`,
            data: { resource: resourceData, path: fieldPath },
          });
        }
      }
    }
  }

  // Phase 3b — x-telo-schema-from validation.
  // For each field with a schemaFrom path expression, resolve the anchor ref to get the
  // concrete kind, navigate the JSON Pointer into that kind's definition schema, and
  // validate the field value against the resulting sub-schema.
  for (const r of resources) {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;

    const fieldMap = registry.getFieldMapForKind(r.kind, aliases);
    if (!fieldMap) continue;

    const resourceLabel = `${r.kind}/${r.metadata.name as string}`;
    const resourceData = { kind: r.kind, name: r.metadata.name as string };

    for (const [fieldPath, entry] of fieldMap) {
      if (!isSchemaFromEntry(entry)) continue;

      const { schemaFrom } = entry;
      const isAbsolute = schemaFrom.startsWith("/");
      const expr = isAbsolute ? schemaFrom.slice(1) : schemaFrom;
      const slashIdx = expr.indexOf("/");
      if (slashIdx === -1) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "INVALID_SCHEMA_FROM",
          source: SOURCE,
          message: `${resourceLabel}: x-telo-schema-from "${schemaFrom}" must contain at least one "/" to separate anchor from JSON Pointer`,
          data: { resource: resourceData, path: fieldPath },
        });
        continue;
      }

      const anchorName = expr.slice(0, slashIdx);
      const jsonPointer = "/" + expr.slice(slashIdx + 1);

      // Derive the anchor path in the resource config.
      let anchorPath: string;
      if (isAbsolute) {
        anchorPath = anchorName;
      } else {
        // Relative: replace the last dot-segment of fieldPath with anchorName.
        // e.g. "nodes[].options" → "nodes[].backend"
        const lastDot = fieldPath.lastIndexOf(".");
        anchorPath = lastDot === -1 ? anchorName : fieldPath.slice(0, lastDot + 1) + anchorName;
      }

      const anchorValues = resolveFieldValues(r, anchorPath);
      if (anchorValues.length === 0) continue; // anchor field not set — nothing to validate

      const fieldValues = resolveFieldValues(r, fieldPath);

      for (let i = 0; i < fieldValues.length; i++) {
        const fieldValue = fieldValues[i];
        if (fieldValue == null) continue;

        // For absolute paths, the single anchor applies to all field values.
        const anchorVal = isAbsolute ? anchorValues[0] : anchorValues[i];
        if (!anchorVal || typeof anchorVal !== "object") continue;

        const refVal = anchorVal as Record<string, unknown>;
        if (typeof refVal.kind !== "string") continue;

        const refResolvedKind = aliases.resolveKind(refVal.kind) ?? refVal.kind;
        const refDef = registry.resolve(refVal.kind) ?? registry.resolve(refResolvedKind);
        if (!refDef?.schema) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_FROM_MISSING_PATH",
            source: SOURCE,
            message: `${resourceLabel}: x-telo-schema-from at '${fieldPath}' → kind '${refVal.kind}' has no schema`,
            data: { resource: resourceData, path: fieldPath },
          });
          continue;
        }

        const subSchema = navigateJsonPointer(refDef.schema, jsonPointer);
        if (subSchema === undefined) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_FROM_MISSING_PATH",
            source: SOURCE,
            message: `${resourceLabel}: x-telo-schema-from at '${fieldPath}' → kind '${refVal.kind}' has no schema path '${jsonPointer}'`,
            data: { resource: resourceData, path: fieldPath },
          });
          continue;
        }

        const issues = registry.validateWithRefs(fieldValue, subSchema as Record<string, any>);
        for (const issue of issues) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "DEPENDENT_SCHEMA_MISMATCH",
            source: SOURCE,
            message: `${resourceLabel}: '${fieldPath}' does not match schema from '${refVal.kind}${jsonPointer}': ${issue}`,
            data: { resource: resourceData, path: fieldPath },
          });
        }
      }
    }
  }

  return diagnostics;
}
