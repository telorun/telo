import type { AnalysisRegistry } from "@telorun/analyzer";
import type { CompletionResult, ReplaceRange } from "../types.js";
import { offeredValueTags, type ValueTag } from "../value-tags/offered-value-tags.js";
import { fieldSchemaAt, lookupRefConstraints } from "./detect-context.js";

/** `!ref` names a resource rather than producing a value, so it is offered at a
 *  reference slot alone — never beside the value tags. */
const REF_TAG: ValueTag = { id: "ref", label: "!ref", hint: "A reference to a named resource." };

export interface ValueTagSite {
  kind?: string;
  yamlPath: string[];
  concretePath: string;
  isItem: boolean;
  bare: boolean;
  replaceRange: ReplaceRange;
}

/**
 * The YAML tags the field under the cursor takes.
 *
 * The same rule studio's schema form applies (`offeredValueTags`), asked of the
 * field's declared schema and of the analyzer's eval mode at the site. Where the
 * field cannot be resolved nothing is known against a tag, so every one is
 * offered rather than none.
 *
 * On a tag with nothing after it, a pick carries a trailing space and, for a tag
 * naming a module location, reopens completion on the path.
 */
export function valueTagCompletions(
  site: ValueTagSite,
  registry: AnalysisRegistry | undefined,
): CompletionResult[] {
  return tagsAt(site, registry).map((tag, index) => ({
    label: tag.label,
    kind: "keyword",
    detail: tag.hint,
    insertText: site.bare ? `${tag.label} ` : tag.label,
    replaceRange: site.replaceRange,
    retrigger: site.bare && tag.names !== undefined,
    sortText: String(index).padStart(2, "0"),
  }));
}

function tagsAt(site: ValueTagSite, registry: AnalysisRegistry | undefined): ValueTag[] {
  const { kind } = site;
  const schema = kind ? registry?.resolveDefinition(kind)?.schema : undefined;
  if (!registry || !kind || !schema) return [...offeredValueTags(undefined, undefined), REF_TAG];
  const schemaFrom = (from: string) => registry.resolveSchemaFrom(from, kind);
  if (lookupRefConstraints(schema as Record<string, any>, site.yamlPath, schemaFrom).length > 0) {
    return [REF_TAG];
  }
  const field = fieldSchemaAt(schema as Record<string, any>, site.yamlPath, site.isItem, schemaFrom);
  return offeredValueTags(field, registry.celEvalModeAt(kind, site.concretePath));
}
