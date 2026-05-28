import type { ResourceManifest } from "@telorun/sdk";
import { collectRefs, isInlineResource } from "./reference-field-map.js";
import {
  collectProperties,
  resolveRef,
  substituteCelFields,
  validateAgainstSchema,
} from "./schema-compat.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** Minimal view of a definition needed to validate an inline resource's config. */
export interface InlineDefinitionLookup {
  (kind: string): { schema?: Record<string, any> } | undefined;
}

/**
 * Validates inline resources nested inside a resource body against their kind's
 * config schema. The per-resource walk in `analyze()` validates a resource's
 * own top-level config; inline resources at `x-telo-ref` slots reachable only
 * through a local `$ref` (notably `Run.Sequence`'s `steps[].invoke`, hidden
 * behind `#/$defs/step`) never reach the reference field map, so they would
 * otherwise escape schema validation — e.g. `invoke: { kind: Console.ReadLine,
 * prompt: "…" }`, where `prompt` belongs in the step's `inputs`, not the config.
 *
 * Walks the manifest data together with its definition schema, resolving local
 * `$ref`s (so step trees of arbitrary depth are covered). At each `x-telo-ref`
 * slot holding an inline resource, the inline's config is validated against its
 * own kind's schema, then recursed into so inline resources nested inside
 * inline resources are covered.
 *
 * Non-mutating: reads `manifest` and emits diagnostics anchored to its identity
 * and a concrete dotted path matching the position-index key format;
 * `rewriteSyntheticOrigins` reroutes those on inline-extracted (synthetic)
 * manifests back to the root doc.
 */
export function validateNestedInlineResources(
  manifest: ResourceManifest,
  rootSchema: Record<string, any>,
  lookupDefinition: InlineDefinitionLookup,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const resource = { kind: manifest.kind, name: manifest.metadata?.name as string };
  const filePath = (manifest.metadata as { source?: string } | undefined)?.source;

  function validateInline(inline: Record<string, any>, path: string): void {
    const kind = inline.kind as string;
    const def = lookupDefinition(kind);
    // Unknown kind: these `$ref`-hidden slots are invisible to the field-map
    // driven reference checks too, so nothing else would flag it — report here.
    if (!def) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "UNDEFINED_KIND",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: inline ${kind} at '${path}': No Telo.Definition found for kind '${kind}'.`,
        data: { resource, filePath, path: `${path}.kind` },
      });
      return;
    }
    // Kind exists but declares no config schema (e.g. a pure Telo.Type): no
    // config to validate and no schema-declared slots to nest resources in.
    if (!def.schema) return;
    const schema = def.schema;
    // `kind` / `metadata` are implicit on every resource; inject them so a
    // strict `additionalProperties: false` config schema doesn't reject them.
    const effectiveSchema =
      schema.additionalProperties === false
        ? {
            ...schema,
            properties: {
              kind: { type: "string" },
              metadata: { type: "object" },
              ...schema.properties,
            },
          }
        : schema;
    // Inline resources omit `metadata` — it is synthesized when the kernel
    // registers them (and by `normalizeInlineResources` for extracted slots,
    // which assigns a derived `metadata.name`). Config schemas conventionally
    // declare `required: ["metadata", …]` with `metadata.name` required, so add
    // a placeholder before validating to mirror the post-registration shape.
    const existingMeta =
      inline.metadata && typeof inline.metadata === "object"
        ? (inline.metadata as Record<string, unknown>)
        : {};
    const data = { ...inline, metadata: { name: "__inline__", ...existingMeta } };
    const substituted = substituteCelFields(data, effectiveSchema, effectiveSchema);
    for (const issue of validateAgainstSchema(substituted, effectiveSchema)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "SCHEMA_VIOLATION",
        source: SOURCE,
        message: `${resource.kind}/${resource.name}: inline ${kind} at '${path}': ${issue.message}`,
        data: { resource, filePath, path: issue.path ? `${path}.${issue.path}` : path },
      });
    }
    // Recurse into the inline body against its own schema so deeper inline
    // resources (e.g. an inline Run.Sequence's own steps) are validated too.
    walk(inline, schema, schema, path);
  }

  function walk(
    data: unknown,
    schema: Record<string, any> | undefined,
    schemaRoot: Record<string, any>,
    path: string,
  ): void {
    if (!schema || typeof schema !== "object") return;
    const resolved = resolveRef(schema, schemaRoot);

    // Reference slot: the value is either a named reference (`{kind, name}`,
    // validated as its own manifest) or an inline resource to validate here.
    if (collectRefs(resolved).length > 0) {
      if (
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        isInlineResource(data as Record<string, unknown>)
      ) {
        validateInline(data as Record<string, any>, path);
      }
      return;
    }

    if (Array.isArray(data)) {
      const itemSchema = resolved.items as Record<string, any> | undefined;
      if (!itemSchema) return;
      for (let i = 0; i < data.length; i++) {
        walk(data[i], itemSchema, schemaRoot, `${path}[${i}]`);
      }
      return;
    }

    if (data && typeof data === "object") {
      const props = collectProperties(resolved);
      const additional =
        resolved.additionalProperties &&
        typeof resolved.additionalProperties === "object" &&
        !Array.isArray(resolved.additionalProperties)
          ? (resolved.additionalProperties as Record<string, any>)
          : undefined;
      // Descend only where the schema declares structure. Freeform fields
      // (`additionalProperties: true`, e.g. step `inputs`) carry caller data
      // that may coincidentally look like `{kind: …}`; not descending there
      // keeps the inline-resource detection anchored to real ref slots.
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        const propSchema = props[key] ?? additional;
        if (!propSchema) continue;
        walk(value, propSchema as Record<string, any>, schemaRoot, path ? `${path}.${key}` : key);
      }
    }
  }

  walk(manifest, rootSchema, rootSchema, "");
  return diagnostics;
}
