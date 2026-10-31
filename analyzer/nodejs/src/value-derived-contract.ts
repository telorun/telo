import { isTaggedSentinel } from "@telorun/templating";
import {
  isSingleValueScope,
  readValueSchemaLocations,
  resolveScopeValues,
  valueSchemaSlots,
} from "./value-schema-slot.js";

/**
 * The contract a resource's own value slot implies when the contract field is
 * left undeclared.
 *
 * `x-telo-value-schema-from: <field>` says the annotated value IS what `<field>`
 * types — a sequence's `outputs:` map is its result. Read forward, a declared
 * `outputType` checks that map; read in reverse, an undeclared one is the map's
 * key set, so a consumer reading `result.<key>` is checked against the keys the
 * resource actually produces. The keys are what is closed; each value stays
 * unconstrained.
 *
 * A slot names the field when one of its locations is the field itself, read
 * whole — beside further locations too, since the value is still what the field
 * types. Only a kind with exactly ONE slot naming the field, holding one value per
 * resource, implies a contract: slots under an array (a decision table's rows)
 * are several candidate producers, and their union is a separate question. A
 * slot written as one CEL expression computes its keys, so it implies nothing.
 */
export function valueDerivedContract(
  manifest: Record<string, any> | undefined,
  defSchema: Record<string, any> | undefined,
  field: string,
): Record<string, any> | undefined {
  if (!manifest || !defSchema) return undefined;
  const scope = derivingScope(defSchema, field);
  if (scope === undefined) return undefined;
  const [site] = resolveScopeValues(manifest, scope);
  const value = site?.value as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || isTaggedSentinel(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, {}])),
    required: keys,
    additionalProperties: false,
  };
}

/** The scope of the one slot a kind's schema derives `field` from (`$.outputs`),
 *  when it has exactly one holding one value per resource. */
function derivingScope(defSchema: Record<string, any>, field: string): string | undefined {
  const slots = valueSchemaSlots(defSchema).filter((slot) => namesField(slot.from, field));
  return slots.length === 1 && isSingleValueScope(slots[0]!.scope) ? slots[0]!.scope : undefined;
}

/** Where a resource's value slot implying `field` is — the place
 *  {@link valueDerivedContract} reads, as keys — when its kind has one. */
export function valueDerivedSlot(defSchema: Record<string, any> | undefined, field: string): string[] | undefined {
  const scope = defSchema && derivingScope(defSchema, field);
  return scope?.startsWith("$.") ? scope.slice(2).split(".") : undefined;
}

function namesField(from: unknown, field: string): boolean {
  return (readValueSchemaLocations(from) ?? []).some(
    (location) =>
      !("invalid" in location) &&
      !location.member &&
      location.segments.length === 1 &&
      location.segments[0] === field,
  );
}
