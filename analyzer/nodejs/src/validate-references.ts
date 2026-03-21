import type { ResourceManifest } from "@telorun/sdk";
import { isRefEntry, isScopeEntry } from "./reference-field-map.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisContext } from "./types.js";

const SOURCE = "telo-analyzer";
const SYSTEM_KINDS = new Set(["Kernel.Definition", "Kernel.Module", "Kernel.Import"]);

/** Inline resource — has keys beyond kind/name/metadata. Phase 2 normalizes these before
 *  Phase 3 runs; until then we skip them rather than raise false errors. */
function isInlineResource(val: Record<string, unknown>): boolean {
  const known = new Set(["kind", "name", "metadata"]);
  return Object.keys(val).some((k) => !known.has(k));
}

/** Resolves all values at a field map path in a resource config.
 *  `[]` in a path segment means "iterate array at this key". */
function resolveFieldValues(obj: unknown, path: string): unknown[] {
  const parts = path.split(".");
  let current: unknown[] = [obj];

  for (const part of parts) {
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    const next: unknown[] = [];

    for (const item of current) {
      if (!item || typeof item !== "object") continue;
      const val = (item as Record<string, unknown>)[key];
      if (val == null) continue;
      if (isArray && Array.isArray(val)) next.push(...val);
      else if (!isArray) next.push(val);
    }

    current = next;
  }

  return current;
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
  const byName = new Map<string, ResourceManifest>();
  for (const r of resources) {
    if (r.metadata?.name) byName.set(r.metadata.name as string, r);
  }

  for (const r of resources) {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;

    const resolvedKind = aliases.resolveKind(r.kind);
    const fieldMap =
      registry.getFieldMap(r.kind) ??
      (resolvedKind ? registry.getFieldMap(resolvedKind) : undefined);
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
        if (!val || typeof val !== "object") continue;
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

        // 2. Kind check — at least one ref entry must accept this kind (anyOf semantics).
        const refKindResolved = aliases.resolveKind(refVal.kind) ?? refVal.kind;
        const kindErrors: string[] = [];
        let kindValid = false;

        for (const refStr of entry.refs) {
          const targetKind = registry.resolveRef(refStr);
          if (!targetKind) {
            // Identity not registered — skip kind check (may be a partial IDE context).
            kindValid = true;
            break;
          }
          const targetDef = registry.resolve(targetKind);
          if (!targetDef) {
            kindValid = true; // unknown target in this context, skip
            break;
          }

          if (targetDef.kind === "Kernel.Abstract") {
            // Abstract target — the referenced resource's definition must extend targetKind.
            const implementing = registry.getByExtends(targetKind);
            const implementingKinds = new Set(
              implementing.map((d) => `${d.metadata.module}.${d.metadata.name}`),
            );
            if (implementingKinds.has(refKindResolved)) {
              kindValid = true;
              break;
            }
            const options = [...implementingKinds].join(", ") || "none registered";
            kindErrors.push(
              `'${refVal.kind}' does not implement '${targetKind}' (known implementations: ${options})`,
            );
          } else {
            // Concrete target — alias-resolved kind must equal the canonical target kind.
            if (refKindResolved === targetKind) {
              kindValid = true;
              break;
            }
            kindErrors.push(
              `'${refVal.kind}' (resolved: '${refKindResolved}') does not match required '${targetKind}'`,
            );
          }
        }

        if (!kindValid && kindErrors.length > 0) {
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

  return diagnostics;
}
