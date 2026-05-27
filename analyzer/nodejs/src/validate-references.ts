import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { isRefEntry, isScopeEntry, isSchemaFromEntry, isInlineResource, resolveFieldEntries, resolveFieldValues, type RefFieldEntry } from "./reference-field-map.js";
import { navigateJsonPointer } from "./schema-compat.js";
import { REF_VALIDATION_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type AnalysisContext } from "./types.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";

const SOURCE = "telo-analyzer";

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
    if (targetDef.kind === "Telo.Abstract") {
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
  const aliasesByModule = context.aliasesByModule;
  if (!aliases || !registry) return diagnostics;

  // Build outer resource lookup by name for resolution check, collecting
  // every entry per name so we can surface name collisions as diagnostics
  // (the kernel's resource registry shares one namespace across all
  // non-system kinds — e.g. `Telo.Application HelloApi` and `Http.Api
  // HelloApi` collide at boot with `ERR_DUPLICATE_RESOURCE`. Catching it
  // statically removes a class of "everything analyzes clean, then the
  // kernel refuses to start" surprises.)
  //
  // Telo.Import is excluded from the duplicate check on top of the
  // SYSTEM_KINDS skip: its `metadata.name` is an alias, not a resource
  // identity (aliases live in a separate namespace from resources, and
  // colliding aliases vs. resource names is benign — the alias is only
  // ever read as a kind prefix).
  // Group manifests by name to detect collisions. Two subtleties:
  //
  //   1. Some analyzer hosts emit the SAME physical document twice through
  //      their pipeline — e.g. the telo-editor's `toAnalysisManifests` walks
  //      each workspace module's documents independently, and a file
  //      reachable from two angles (entry module + `include:` partial)
  //      shows up twice. The fingerprint includes `sourceLine` so identical
  //      docs (same kind, name, source, AND source line) collapse to one,
  //      while two textually-separate documents in the same file (different
  //      source lines) keep separate fingerprints and trip the diagnostic.
  //   2. The diagnostic carries a precomputed `range` pointing at the
  //      duplicate's source line — editor hosts that resolve diagnostic
  //      positions via a `${file}::${kind}::${name}` lookup would otherwise
  //      collide on duplicates (Map.set overwrites) and place the squiggle
  //      ambiguously. The explicit `range` short-circuits that lookup.
  // Dedup pipeline echoes — the same physical document emitted twice
  // through an analyzer host's pipeline. Keyed on (kind, name, source,
  // sourceLine), so two textually-distinct docs in the same file (same
  // source, different sourceLine) keep separate fingerprints and still
  // trip the diagnostic. `analyze()` enforces that every non-system
  // manifest carries both positional fields — no defensive guard needed.
  const byNameAll = new Map<string, ResourceManifest[]>();
  const seen = new Set<string>();
  for (const r of resources) {
    if (!r.metadata?.name || SYSTEM_KINDS.has(r.kind) || r.kind === "Telo.Import") continue;
    const name = r.metadata.name as string;
    // `analyze()` guarantees both fields are present on non-system manifests.
    const meta = r.metadata as unknown as { source: string; sourceLine: number };
    const fingerprint = `${r.kind} ${name} ${meta.source} ${meta.sourceLine}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const existing = byNameAll.get(name);
    if (existing) existing.push(r);
    else byNameAll.set(name, [r]);
  }
  for (const [name, list] of byNameAll) {
    if (list.length <= 1) continue;
    const [first, ...rest] = list;
    const firstLabel = `${first.kind}/${name}`;
    for (const dup of rest) {
      const dupMeta = dup.metadata as { source?: string; sourceLine?: number } | undefined;
      const range =
        typeof dupMeta?.sourceLine === "number"
          ? {
              start: { line: dupMeta.sourceLine, character: 0 },
              end: { line: dupMeta.sourceLine, character: Number.MAX_SAFE_INTEGER },
            }
          : undefined;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "DUPLICATE_RESOURCE_NAME",
        source: SOURCE,
        message: `${dup.kind}/${name}: resource name collides with ${firstLabel} declared earlier (kernel runtime would fail with ERR_DUPLICATE_RESOURCE)`,
        ...(range ? { range } : {}),
        data: {
          resource: { kind: dup.kind, name },
          filePath: dupMeta?.source,
          path: "metadata.name",
        },
      });
    }
  }
  // Single-resource map for the resolution / scope lookups below — when a
  // collision exists, falling back to the first occurrence keeps the rest
  // of the pass behaving the same as before the duplicate diagnostic was
  // added (resolution still finds *something*; the duplicate diagnostic
  // is what surfaces the underlying problem to the user).
  const byName = new Map<string, ResourceManifest>();
  for (const [name, list] of byNameAll) byName.set(name, list[0]);

  for (const r of resources) {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;

    // Use the expanded map so refs nested behind x-telo-schema-from get the
    // same kind-check / unresolved-name validation as locally-declared refs.
    // Falls back to the base map when aliasesByModule isn't supplied.
    const fieldMap = aliasesByModule
      ? registry.expandedFieldMapForResource(r, aliases, aliasesByModule)
      : registry.getFieldMapForKind(r.kind, aliases);
    if (!fieldMap) continue;

    const resourceLabel = `${r.kind}/${r.metadata.name as string}`;
    const resourceData = { kind: r.kind, name: r.metadata.name as string };
    const filePath = (r.metadata as { source?: string } | undefined)?.source;

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

      for (const { value: val, path: concretePath } of resolveFieldEntries(r, fieldPath)) {
        if (!val) continue;

        // `!ref <name>` sentinel — bare resource name marked at parse time as a
        // reference. Look it up against the slot's x-telo-ref constraint exactly
        // like the legacy bare-string path; the only difference is the value's
        // shape (a TaggedSentinel rather than a raw string), which removed the
        // string/inline ambiguity at the source.
        if (isRefSentinel(val)) {
          const refName = val.source;
          const target =
            byName.get(refName) ?? visibleScopeManifests.find((m) => m.metadata?.name === refName);
          if (!target) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "UNRESOLVED_REFERENCE",
              source: SOURCE,
              message: `${resourceLabel}: reference at '${concretePath}' → resource '${refName}' not found`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
            continue;
          }
          const kindErrors = checkKind(target.kind as string, entry, registry, aliases);
          if (kindErrors.length > 0) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "REFERENCE_KIND_MISMATCH",
              source: SOURCE,
              message: `${resourceLabel}: reference at '${concretePath}' → ${kindErrors.join("; ")}`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
          }
          continue;
        }

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
              message: `${resourceLabel}: reference at '${concretePath}' → resource '${val}' not found`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
            continue;
          }
          const kindErrors = checkKind(target.kind as string, entry, registry, aliases);
          if (kindErrors.length > 0) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "REFERENCE_KIND_MISMATCH",
              source: SOURCE,
              message: `${resourceLabel}: reference at '${concretePath}' → ${kindErrors.join("; ")}`,
              data: { resource: resourceData, filePath, path: concretePath },
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
            message: `${resourceLabel}: reference at '${concretePath}' must have string 'kind' and 'name' fields`,
            data: { resource: resourceData, filePath, path: concretePath },
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
            message: `${resourceLabel}: reference at '${concretePath}' → ${kindErrors.join("; ")}`,
            data: { resource: resourceData, filePath, path: concretePath },
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
            message: `${resourceLabel}: reference at '${concretePath}' → resource '${refVal.name}' not found`,
            data: { resource: resourceData, filePath, path: concretePath },
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
    const filePath = (r.metadata as { source?: string } | undefined)?.source;

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
          data: { resource: resourceData, filePath, path: fieldPath },
        });
        continue;
      }

      const anchorName = expr.slice(0, slashIdx);
      const jsonPointer = "/" + expr.slice(slashIdx + 1);

      // Aliased absolute kind path — first segment carries a dot, e.g.
      // "HttpDispatch.Outcomes/$defs/Returns". Resolves the alias through the
      // *kind owner's* scope (not the consumer's), navigates the JSON Pointer
      // into the resolved definition's schema, and validates each field value.
      //
      // Relative anchors are property names that cannot contain a dot
      // (CEL-style identifiers), so a dot in anchorName is unambiguous.
      if (!isAbsolute && anchorName.includes(".")) {
        const resolvedResourceKind = aliases.resolveKind(r.kind) ?? r.kind;
        const resourceDef =
          registry.resolve(r.kind) ?? registry.resolve(resolvedResourceKind);
        const owningModule = (resourceDef?.metadata as { module?: string } | undefined)?.module;
        const ownerScope =
          (owningModule ? aliasesByModule?.get(owningModule) : undefined) ?? aliases;

        const targetKind = ownerScope.resolveKind(anchorName);
        if (!targetKind) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_FROM_MISSING_PATH",
            source: SOURCE,
            message: `${resourceLabel}: x-telo-schema-from at '${fieldPath}' → cannot resolve alias '${anchorName}'`,
            data: { resource: resourceData, filePath, path: fieldPath },
          });
          continue;
        }

        const targetDef = registry.resolve(targetKind);
        if (!targetDef?.schema) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_FROM_MISSING_PATH",
            source: SOURCE,
            message: `${resourceLabel}: x-telo-schema-from at '${fieldPath}' → kind '${targetKind}' has no schema`,
            data: { resource: resourceData, filePath, path: fieldPath },
          });
          continue;
        }

        const subSchema = navigateJsonPointer(targetDef.schema, jsonPointer);
        if (subSchema === undefined) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_FROM_MISSING_PATH",
            source: SOURCE,
            message: `${resourceLabel}: x-telo-schema-from at '${fieldPath}' → kind '${targetKind}' has no schema path '${jsonPointer}'`,
            data: { resource: resourceData, filePath, path: fieldPath },
          });
          continue;
        }

        for (const { value: fieldValue, path: concretePath } of resolveFieldEntries(r, fieldPath)) {
          if (fieldValue == null) continue;
          const issues = registry.validateWithRefs(fieldValue, subSchema as Record<string, any>);
          for (const issue of issues) {
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: "DEPENDENT_SCHEMA_MISMATCH",
              source: SOURCE,
              message: `${resourceLabel}: '${concretePath}' does not match schema from '${anchorName}${jsonPointer}': ${issue}`,
              data: { resource: resourceData, filePath, path: concretePath },
            });
          }
        }
        continue;
      }

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

      const fieldEntries = resolveFieldEntries(r, fieldPath);

      for (let i = 0; i < fieldEntries.length; i++) {
        const { value: fieldValue, path: concretePath } = fieldEntries[i];
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
            message: `${resourceLabel}: x-telo-schema-from at '${concretePath}' → kind '${refVal.kind}' has no schema`,
            data: { resource: resourceData, filePath, path: concretePath },
          });
          continue;
        }

        const subSchema = navigateJsonPointer(refDef.schema, jsonPointer);
        if (subSchema === undefined) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "SCHEMA_FROM_MISSING_PATH",
            source: SOURCE,
            message: `${resourceLabel}: x-telo-schema-from at '${concretePath}' → kind '${refVal.kind}' has no schema path '${jsonPointer}'`,
            data: { resource: resourceData, filePath, path: concretePath },
          });
          continue;
        }

        const issues = registry.validateWithRefs(fieldValue, subSchema as Record<string, any>);
        for (const issue of issues) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "DEPENDENT_SCHEMA_MISMATCH",
            source: SOURCE,
            message: `${resourceLabel}: '${concretePath}' does not match schema from '${refVal.kind}${jsonPointer}': ${issue}`,
            data: { resource: resourceData, filePath, path: concretePath },
          });
        }
      }
    }
  }

  return diagnostics;
}
