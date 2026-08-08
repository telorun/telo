import { inferType } from "./field-control";
import {
  collectRefTargets,
  resolveRefCandidates,
  toRefValue,
  type RefResolver,
} from "./ref-candidates";
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

  // Every accepted kind, not just a directly-annotated one: a slot whose ref
  // sits in an `anyOf` branch renders as a picker, so it must seed a default
  // ref too or the widget opens on a value its own control cannot produce.
  const refTargets = collectRefTargets(prop);
  if (refTargets.length > 0) {
    const options = resolveRefCandidates(refTargets, resolvedResources, registry);
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
