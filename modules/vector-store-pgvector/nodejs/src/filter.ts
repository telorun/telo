import type { FieldCondition, FilterScalar, MetadataFilter } from "@telorun/vector-store";

const OPERATORS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"]);

/** A translated filter: a boolean SQL fragment over the `metadata` JSONB column
 *  plus the positional parameters it references (all bound, never spliced). */
export interface CompiledFilter {
  sql: string;
  params: unknown[];
}

/**
 * Accumulates positional placeholders from a caller-controlled starting index so
 * the emitted fragment slots into a larger prepared statement whose earlier
 * placeholders (the query vector, the limit) are already numbered.
 */
class ParamBuilder {
  readonly params: unknown[] = [];
  constructor(private next: number) {}

  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.next++}`;
  }
}

function isScalar(value: unknown): value is FilterScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** `metadata->'field'` compared as JSONB against a bound `::jsonb` literal. */
function jsonbEq(field: string, value: FilterScalar, b: ParamBuilder): string {
  return `metadata->${b.bind(field)} = ${b.bind(JSON.stringify(value))}::jsonb`;
}

/** Numeric comparison guarded so a non-numeric (or absent) field is a non-match
 *  rather than a cast error — mirrors the memory backend's typeof check. */
function jsonbNumeric(field: string, op: string, operand: number, b: ParamBuilder): string {
  const f = b.bind(field);
  return `(jsonb_typeof(metadata->${f}) = 'number' AND (metadata->>${f})::numeric ${op} ${b.bind(operand)})`;
}

function inList(field: string, values: FilterScalar[], b: ParamBuilder): string {
  if (values.length === 0) return "FALSE";
  const f = b.bind(field);
  const items = values.map((v) => `${b.bind(JSON.stringify(v))}::jsonb`).join(", ");
  return `metadata->${f} = ANY(ARRAY[${items}])`;
}

function condition(field: string, cond: FilterScalar | FieldCondition, b: ParamBuilder): string {
  if (isScalar(cond)) {
    return jsonbEq(field, cond, b);
  }
  const clauses: string[] = [];
  for (const [op, operand] of Object.entries(cond)) {
    if (operand === undefined) continue;
    if (!OPERATORS.has(op)) {
      throw new Error(`VectorStorePgvector: unsupported filter operator '${op}'.`);
    }
    switch (op) {
      case "$eq":
        clauses.push(jsonbEq(field, operand as FilterScalar, b));
        break;
      case "$ne":
        // IS DISTINCT FROM so an absent field (JSONB NULL) counts as not-equal,
        // matching the memory backend (undefined !== operand → passes).
        clauses.push(
          `metadata->${b.bind(field)} IS DISTINCT FROM ${b.bind(JSON.stringify(operand))}::jsonb`,
        );
        break;
      case "$gt":
        clauses.push(jsonbNumeric(field, ">", operand as number, b));
        break;
      case "$gte":
        clauses.push(jsonbNumeric(field, ">=", operand as number, b));
        break;
      case "$lt":
        clauses.push(jsonbNumeric(field, "<", operand as number, b));
        break;
      case "$lte":
        clauses.push(jsonbNumeric(field, "<=", operand as number, b));
        break;
      case "$in":
        clauses.push(inList(field, operand as FilterScalar[], b));
        break;
      case "$nin": {
        const f = b.bind(field);
        const items = (operand as FilterScalar[]).map(
          (v) => `${b.bind(JSON.stringify(v))}::jsonb`,
        );
        // Absent field passes $nin (not in the list); guard the NULL explicitly.
        clauses.push(
          items.length === 0
            ? "TRUE"
            : `(metadata->${f} IS NULL OR NOT (metadata->${f} = ANY(ARRAY[${items.join(", ")}])))`,
        );
        break;
      }
    }
  }
  return clauses.length ? `(${clauses.join(" AND ")})` : "TRUE";
}

function translate(filter: MetadataFilter, b: ParamBuilder): string {
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (key === "$and") {
      const parts = (value as MetadataFilter[]).map((f) => translate(f, b));
      clauses.push(parts.length ? `(${parts.join(" AND ")})` : "TRUE");
    } else if (key === "$or") {
      const parts = (value as MetadataFilter[]).map((f) => translate(f, b));
      clauses.push(parts.length ? `(${parts.join(" OR ")})` : "FALSE");
    } else if (key === "$not") {
      clauses.push(`NOT ${translate(value as MetadataFilter, b)}`);
    } else {
      clauses.push(condition(key, value as FilterScalar | FieldCondition, b));
    }
  }
  return clauses.length ? `(${clauses.join(" AND ")})` : "TRUE";
}

/**
 * Compile a MongoDB-style metadata filter into a JSONB SQL predicate whose
 * placeholders start at `startIndex`. Returns `undefined` when there is no
 * filter, so the caller emits no WHERE clause. Unsupported operators throw,
 * preserving cross-backend parity with the memory backend.
 */
export function compileFilter(
  filter: MetadataFilter | undefined,
  startIndex: number,
): CompiledFilter | undefined {
  if (!filter) return undefined;
  const b = new ParamBuilder(startIndex);
  const sql = translate(filter, b);
  return { sql, params: b.params };
}
