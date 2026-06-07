import { inferType } from "./field-control";
import { resolveRefCandidates, toRefValue, type RefResolver } from "./ref-candidates";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

/** Editor-coupled default-value builder. Aware of `x-telo-ref` resolution
 *  against `ResolvedResourceOption[]`, so it does not belong in a generic
 *  JSON Schema utility — keep the editor-scoped name to discourage lifting. */
export function buildEditorDefaultValue(
  prop: JsonSchemaProperty,
  resolvedResources: ResolvedResourceOption[],
  registry?: RefResolver | null,
): unknown {
  if (prop.default !== undefined) return prop.default;

  const refTarget = prop["x-telo-ref"];
  if (typeof refTarget === "string") {
    const options = resolveRefCandidates([refTarget], resolvedResources, registry);
    if (options.length === 0) return undefined;
    return toRefValue(options[0]);
  }

  const kind = inferType(prop);
  if (kind === "boolean") return false;
  if (kind === "integer" || kind === "number") return 0;
  if (kind === "array") return [];
  if (kind === "object") return {};
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  return "";
}
