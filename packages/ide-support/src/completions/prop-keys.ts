import type { AnalysisRegistry } from "@telorun/analyzer";
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
): CompletionResult[] {
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
    : navigateSchema(definition.schema as Record<string, any>, yamlPath);

  if (!targetSchema?.properties) {
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
      : (targetSchema.properties as Record<string, any>);

  return buildItems(properties, existingKeys, required);
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
