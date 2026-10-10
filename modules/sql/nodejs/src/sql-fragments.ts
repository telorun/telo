/**
 * Statement text as literal fragments with a bound value between each pair —
 * the shape the connection's `executeTemplate` takes, which renders each gap as
 * its dialect's own placeholder. Identifiers are only ever written into the
 * text, already quoted, from declarations; a value is only ever a gap.
 */
export class SqlFragments {
  private readonly parts: string[] = [""];
  private readonly bound: unknown[] = [];

  text(sql: string): this {
    this.parts[this.parts.length - 1] += sql;
    return this;
  }

  value(value: unknown): this {
    this.bound.push(value);
    this.parts.push("");
    return this;
  }

  /** Values joined by `separator`, each a gap. */
  valueList(values: readonly unknown[], separator: string): this {
    values.forEach((value, index) => {
      if (index > 0) this.text(separator);
      this.value(value);
    });
    return this;
  }

  append(other: SqlFragments): this {
    this.text(other.parts[0]);
    other.bound.forEach((value, index) => {
      this.value(value);
      this.text(other.parts[index + 1]);
    });
    return this;
  }

  get fragments(): string[] {
    return [...this.parts];
  }

  get boundValues(): unknown[] {
    return [...this.bound];
  }
}

const COMPARISON_SQL = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
} as const;

export type SqlComparisonOperator = keyof typeof COMPARISON_SQL;

/**
 * One comparison of `column` — an identifier already quoted, from a declaration
 * — with a bound value. A null value under `eq` / `ne` asks whether the column
 * holds nothing / something; under any other operator it is bound as it is, and
 * a comparison with NULL matches no row.
 */
export function sqlComparison(
  column: string,
  operator: SqlComparisonOperator,
  value: unknown,
): SqlFragments {
  if (value === null && operator === "eq") return new SqlFragments().text(`${column} IS NULL`);
  if (value === null && operator === "ne") return new SqlFragments().text(`${column} IS NOT NULL`);
  return new SqlFragments().text(`${column} ${COMPARISON_SQL[operator]} `).value(value);
}

/** ` WHERE a AND b`, or nothing for no conditions. */
export function sqlWhere(conditions: readonly SqlFragments[]): SqlFragments {
  const clause = new SqlFragments();
  conditions.forEach((condition, index) => {
    clause.text(index === 0 ? " WHERE " : " AND ").append(condition);
  });
  return clause;
}
