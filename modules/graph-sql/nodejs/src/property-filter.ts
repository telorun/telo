import { COMPARISON_OPERATORS, type ComparisonOperator, type GraphFilter } from "@telorun/graph";
import { namedColumns, type CompiledColumn } from "./compiled-types.js";
import { SqlFragments } from "./sql-fragments.js";

const OPERATOR_SQL: Record<ComparisonOperator, string> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

/**
 * One condition per operator entry, ANDed by the caller. A null operand under
 * `eq` / `ne` asks whether the property is absent / present; under any other
 * operator it is bound as-is, and a comparison with NULL matches no row — which
 * is the stated rule that no other comparison ever matches an absent property.
 * `ne` of a value likewise never matches a row without the property.
 */
export function filterConditions(
  describe: string,
  typeName: string,
  where: GraphFilter,
  columns: ReadonlyMap<string, CompiledColumn>,
  qualifier: string,
): SqlFragments[] {
  const unknown = Object.keys(where).filter(
    (operator) => !(COMPARISON_OPERATORS as readonly string[]).includes(operator),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${describe}: 'where' names ${unknown.map((o) => `'${o}'`).join(", ")}, which is not an ` +
        `operator. The operators are: ${COMPARISON_OPERATORS.join(", ")}.`,
    );
  }
  const conditions: SqlFragments[] = [];
  for (const operator of COMPARISON_OPERATORS) {
    const operands = where[operator];
    if (!operands) continue;
    for (const { column, value } of namedColumns(describe, typeName, columns, operands)) {
      const target = `${qualifier}${column.sql}`;
      if (value === null && operator === "eq") {
        conditions.push(new SqlFragments().text(`${target} IS NULL`));
      } else if (value === null && operator === "ne") {
        conditions.push(new SqlFragments().text(`${target} IS NOT NULL`));
      } else {
        conditions.push(
          new SqlFragments().text(`${target} ${OPERATOR_SQL[operator]} `).value(value),
        );
      }
    }
  }
  return conditions;
}

/** ` WHERE a AND b`, or nothing for no conditions. */
export function whereClause(conditions: readonly SqlFragments[]): SqlFragments {
  const clause = new SqlFragments();
  conditions.forEach((condition, index) => {
    clause.text(index === 0 ? " WHERE " : " AND ").append(condition);
  });
  return clause;
}
