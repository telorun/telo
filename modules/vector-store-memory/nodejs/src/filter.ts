import type { FieldCondition, FilterScalar, MetadataFilter } from "@telorun/vector-store";

const OPERATORS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"]);

function isScalar(value: unknown): value is FilterScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function matchesCondition(actual: unknown, condition: FilterScalar | FieldCondition): boolean {
  if (isScalar(condition)) {
    return actual === condition;
  }
  for (const [op, operand] of Object.entries(condition)) {
    if (!OPERATORS.has(op)) {
      throw new Error(`VectorStoreMemory: unsupported filter operator '${op}'.`);
    }
    switch (op) {
      case "$eq":
        if (actual !== operand) return false;
        break;
      case "$ne":
        if (actual === operand) return false;
        break;
      case "$gt":
        if (!(typeof actual === "number" && actual > (operand as number))) return false;
        break;
      case "$gte":
        if (!(typeof actual === "number" && actual >= (operand as number))) return false;
        break;
      case "$lt":
        if (!(typeof actual === "number" && actual < (operand as number))) return false;
        break;
      case "$lte":
        if (!(typeof actual === "number" && actual <= (operand as number))) return false;
        break;
      case "$in":
        if (!(operand as FilterScalar[]).includes(actual as FilterScalar)) return false;
        break;
      case "$nin":
        if ((operand as FilterScalar[]).includes(actual as FilterScalar)) return false;
        break;
    }
  }
  return true;
}

/**
 * Evaluate a MongoDB-style metadata filter against a record's metadata. Top-level
 * keys are ANDed; `$and` / `$or` / `$not` compose sub-filters; any other key is a
 * metadata field condition. An unsupported operator throws (never silently
 * matches), preserving cross-backend parity.
 */
export function matchesFilter(
  filter: MetadataFilter | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!filter) return true;
  const meta = metadata ?? {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (key === "$and") {
      if (!(value as MetadataFilter[]).every((f) => matchesFilter(f, meta))) return false;
    } else if (key === "$or") {
      if (!(value as MetadataFilter[]).some((f) => matchesFilter(f, meta))) return false;
    } else if (key === "$not") {
      if (matchesFilter(value as MetadataFilter, meta)) return false;
    } else if (!matchesCondition(meta[key], value as FilterScalar | FieldCondition)) {
      return false;
    }
  }
  return true;
}
