import {
  manifestFragmentOf,
  TELO_SCHEMA_ANNOTATIONS,
  type AnalysisRegistry,
} from "@telorun/analyzer";
import type { CompletionResult } from "../types.js";
import { navigateSchema } from "./detect-context.js";

/** Kernel-implicit fields. Every Telo resource declares its `kind` and a
 *  `metadata` object; the analyzer's schema validator injects them when
 *  the definition uses `additionalProperties: false`. Completion has the
 *  same need — domain-specific schemas (`Http.Api`, `Sql.Query`, …) don't
 *  enumerate these in their own `properties`, so without an explicit fallback
 *  the user can't autocomplete `kind:` or `metadata:` on those resources. */
const ROOT_IMPLICIT_PROPS: Record<string, Record<string, any>> = {
  kind: { type: "string", description: "The fully-qualified resource kind." },
  metadata: {
    type: "object",
    description: "Resource metadata (name, namespace, version).",
  },
};

export function propKeyCompletions(
  kind: string,
  yamlPath: string[],
  existingKeys: Set<string>,
  registry: AnalysisRegistry | undefined,
  /** The arguments the enclosing call declares, when this path IS that call's
   *  argument slot. Resolved by the caller, which is the side holding the
   *  manifest the reference names. */
  callInputs?: Record<string, any>,
): CompletionResult[] {
  if (callInputs?.properties) {
    return buildItems(
      callInputs.properties as Record<string, any>,
      existingKeys,
      new Set<string>(Array.isArray(callInputs.required) ? callInputs.required : []),
    );
  }
  if (!registry) return [];

  const definition = registry.resolveDefinition(kind);
  if (!definition?.schema) {
    // Unknown kind (often: an unloaded import). At root level, still surface
    // the universal `kind` / `metadata` keys so completion isn't dead when
    // the registry hasn't resolved the resource type yet.
    if (yamlPath.length === 0) {
      return buildItems(ROOT_IMPLICIT_PROPS, existingKeys, new Set<string>());
    }
    return [];
  }

  const targetSchema = yamlPath.length === 0
    ? (definition.schema as Record<string, any>)
    : navigateSchema(definition.schema as Record<string, any>, yamlPath, (from) =>
        registry.resolveSchemaFrom(from, kind),
      );

  // A NAME-KEYED map declares its keys nowhere in `properties` — they are the
  // author's own (a media type, a header name). `propertyNames` is JSON
  // Schema's own vocabulary for what they may be, and it carries the open/closed
  // distinction already: `enum` constrains, `examples` only suggests. So an open
  // list of known values needs no annotation and no analyzer-side knowledge of
  // any domain.
  const keySuggestions = propertyNameSuggestions(targetSchema, existingKeys);

  if (!targetSchema?.properties) {
    if (keySuggestions.length > 0) return keySuggestions;
    if (yamlPath.length === 0) {
      return buildItems(ROOT_IMPLICIT_PROPS, existingKeys, new Set<string>());
    }
    return [];
  }

  const required = new Set<string>(
    Array.isArray(targetSchema.required) ? targetSchema.required : [],
  );
  const properties =
    yamlPath.length === 0
      ? { ...ROOT_IMPLICIT_PROPS, ...(targetSchema.properties as Record<string, any>) }
      : { ...(targetSchema.properties as Record<string, any>), ...annotationKeys(targetSchema) };

  return [...keySuggestions, ...buildItems(properties, existingKeys, required)];
}

/**
 * Key candidates a map-valued node declares through `propertyNames`.
 *
 * `enum` is a closed set and `examples` an open one — suggestions with no
 * validation effect, which is exactly "these are the known values, others are
 * allowed". Both are stock JSON Schema, so nothing here knows what a media type
 * is and any name-keyed field gains the same behaviour by declaring it.
 */
function propertyNameSuggestions(
  schema: Record<string, any> | undefined,
  existingKeys: Set<string>,
): CompletionResult[] {
  const names = schema?.propertyNames as Record<string, any> | undefined;
  if (!names || typeof names !== "object") return [];
  const closed = Array.isArray(names.enum) ? (names.enum as unknown[]) : undefined;
  const open = Array.isArray(names.examples) ? (names.examples as unknown[]) : [];
  const values = closed ?? open;

  const out: CompletionResult[] = [];
  for (const value of values) {
    if (typeof value !== "string" || existingKeys.has(value)) continue;
    out.push({
      label: value,
      kind: "enumMember",
      insertText: `${value}: $0`,
      snippet: true,
      detail: closed ? names.title ?? "allowed key" : names.title ?? "known key",
      // Ahead of any structural key at the same level: at a name-keyed slot the
      // author is choosing one of these, not adding a sibling field.
      sortText: `0_${value}`,
    });
  }
  return out;
}

/**
 * The `x-telo-*` vocabulary, offered only inside a KIND's own schema.
 *
 * Read off the fragment stamp rather than the position: a kind schema nests, so
 * "am I inside one" is a fact about the node, not about how deep the cursor
 * sits. A plain data schema — an `inputType:`, a `status:` block — stamps
 * `JsonSchema7` and gets nothing, because an annotation there configures a slot
 * that does not exist.
 *
 * The vocabulary lives on the analyzer side and never enters a manifest: a
 * `properties` map holding a literal `x-telo-ref` key reads to the annotation
 * walkers as an annotated node.
 */
function annotationKeys(node: Record<string, any>): Record<string, any> {
  return manifestFragmentOf(node) === "KindSchema" ? TELO_SCHEMA_ANNOTATIONS : {};
}

function buildItems(
  properties: Record<string, any>,
  existingKeys: Set<string>,
  required: Set<string>,
): CompletionResult[] {
  const items: CompletionResult[] = [];
  for (const [prop, propSchema] of Object.entries(properties)) {
    if (existingKeys.has(prop)) continue;

    const item: CompletionResult = {
      label: prop,
      kind: "property",
      insertText: `${prop}: $0`,
      snippet: true,
    };

    const parts: string[] = [];
    if (propSchema.type) parts.push(propSchema.type);
    if (propSchema.default !== undefined) parts.push(`default: ${JSON.stringify(propSchema.default)}`);
    if (parts.length) item.detail = parts.join("  ");
    if (propSchema.description) item.documentation = propSchema.description;

    if (required.has(prop)) {
      item.preselect = true;
      item.sortText = `0_${prop}`;
    } else {
      item.sortText = `1_${prop}`;
    }

    items.push(item);
  }

  return items;
}
