import type { CelType, ResultOrigin } from "@telorun/cel";
import { schemaNodeOf } from "./cel-schema-node.js";
import { producedValueOf, type ProducedValue, type ProducedValueHost } from "./cel-produced-value.js";

/**
 * One place a forwarded value may come from, as the slot fit reads it: the
 * subexpression as written, its CEL type, the schema node it is an instance of
 * where the engine located one, and — for a computed origin — what its literal
 * tree says about the value.
 */
export interface SlotOrigin {
  readonly text: string;
  readonly type?: CelType;
  /** A navigated forward's type: what kind of value it hands through, its fit being its node's. */
  readonly rootType?: CelType;
  readonly typeName: string;
  readonly node?: Record<string, any>;
  readonly composed?: ProducedValue;
}

/** The engine's origins of `source`'s result, read for the slot fit. */
export function slotOriginsOf(
  source: string,
  origins: readonly ResultOrigin[],
  composeHost: ProducedValueHost,
): SlotOrigin[] {
  return origins.map((origin) => {
    const text = source.slice(origin.range[0], origin.range[1]).trim();
    const located = schemaNodeOf(origin.schemaNode);
    const node = located && Object.keys(located).length > 0 ? located : undefined;
    const composed = origin.schemaNode === undefined ? producedValueOf(text, composeHost) : undefined;
    return {
      text,
      type: origin.type,
      typeName: origin.typeName,
      ...(node ? { node } : {}),
      ...(composed ? { composed } : {}),
    };
  });
}

/** The schema node a plain chain's one origin is an instance of. */
export function chainNodeOf(origins: readonly SlotOrigin[]): Record<string, any> | undefined {
  return origins.length === 1 ? origins[0]!.node : undefined;
}

/** Whether a type holds an optional at any depth — a field, a record's
 *  undeclared members, a tuple's positions and its rest included. */
export function holdsOptional(type: CelType): boolean {
  const pending: CelType[] = [type];
  const seen = new Set<CelType>();
  while (pending.length > 0) {
    const at = pending.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    switch (at.kind) {
      case "optional":
        return true;
      case "list":
        pending.push(at.element, ...(at.prefixElements ?? []));
        if (at.additionalElements) pending.push(at.additionalElements);
        break;
      case "map":
        pending.push(at.key, at.value);
        break;
      case "union":
        pending.push(...at.members);
        break;
      case "record":
        pending.push(...at.fields.values());
        if (at.additionalFields) pending.push(at.additionalFields);
        break;
      case "nominal":
        pending.push(...at.args);
        break;
    }
  }
  return false;
}
