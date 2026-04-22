import type { AnalysisRegistry } from "@telorun/analyzer";
import type { CompletionResult } from "../types.js";
import { navigateSchema } from "./detect-context.js";

export function propKeyCompletions(
  kind: string,
  yamlPath: string[],
  existingKeys: Set<string>,
  registry: AnalysisRegistry | undefined,
): CompletionResult[] {
  if (!registry) return [];

  const definition = registry.resolveDefinition(kind);
  if (!definition?.schema) return [];

  const targetSchema = yamlPath.length === 0
    ? (definition.schema as Record<string, any>)
    : navigateSchema(definition.schema as Record<string, any>, yamlPath);

  if (!targetSchema?.properties) return [];

  const required = new Set<string>(
    Array.isArray(targetSchema.required) ? targetSchema.required : [],
  );
  const items: CompletionResult[] = [];

  for (const [prop, propSchema] of Object.entries(
    targetSchema.properties as Record<string, any>,
  )) {
    if (existingKeys.has(prop)) continue;
    if (yamlPath.length === 0 && (prop === "kind" || prop === "metadata")) continue;

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
