import { COMPARISON_OPERATORS, type ComparisonOperator, type GraphFilter } from "./graph-store.js";

/** One comparison a `where` asks for: a property against a value. */
export interface FilterOperand {
  readonly operator: ComparisonOperator;
  readonly property: string;
  readonly value: unknown;
}

/**
 * Every comparison a `where` holds, in operator order and then in each
 * operator's own property order; all of them are ANDed. A null value under
 * `eq` / `ne` asks whether the property is absent / present, and no other
 * comparison ever matches an absent property — a backend renders that, this
 * only reads the grammar. An operator the grammar does not have is refused.
 */
export function filterOperands(describe: string, where: GraphFilter): FilterOperand[] {
  const unknown = Object.keys(where).filter(
    (operator) => !(COMPARISON_OPERATORS as readonly string[]).includes(operator),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${describe}: 'where' names ${unknown.map((o) => `'${o}'`).join(", ")}, which is not an ` +
        `operator. The operators are: ${COMPARISON_OPERATORS.join(", ")}.`,
    );
  }
  const operands: FilterOperand[] = [];
  for (const operator of COMPARISON_OPERATORS) {
    for (const [property, value] of Object.entries(where[operator] ?? {})) {
      if (value !== undefined) operands.push({ operator, property, value });
    }
  }
  return operands;
}
