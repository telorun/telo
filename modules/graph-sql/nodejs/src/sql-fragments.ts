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
