/**
 * The published protocol schema is open — a receiver ignores members and enum
 * values it does not know (`@telorun/editor-protocol` § Generations). The
 * engine's own messages must carry nothing beyond what this generation defines,
 * so the harness validates them against a CLOSED projection derived here: every
 * object with declared properties admits no others, and every "known values or
 * any string" enumeration admits only the known values.
 */
export function closedProjection<T>(schema: T): T {
  const close = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(close);
    if (!node || typeof node !== "object") return node;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) copy[key] = close(value);
    const anyOf = copy.anyOf as Array<Record<string, unknown>> | undefined;
    const known = anyOf?.find((branch) => Array.isArray(branch.enum));
    if (known && anyOf!.length === 2 && anyOf!.some((branch) => branch.type === "string" && !branch.enum)) {
      delete copy.anyOf;
      copy.enum = known.enum;
    }
    if (copy.properties && typeof copy.properties === "object") copy.additionalProperties = false;
    return copy;
  };
  return close(schema) as T;
}
