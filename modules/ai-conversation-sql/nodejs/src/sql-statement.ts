/** Builds one statement with the dialect's placeholders, numbering them as values are added. */
export class Statement {
  private text = "";
  readonly params: unknown[] = [];

  constructor(private readonly numbered: boolean) {}

  /** Appends literal SQL. */
  sql(fragment: string): this {
    this.text += fragment;
    return this;
  }

  /** Appends a placeholder bound to `value`. */
  value(value: unknown): this {
    this.text += this.p(value);
    return this;
  }

  /** The placeholder for `value`, to embed in a larger expression. */
  p(value: unknown): string {
    this.params.push(value);
    return this.numbered ? "$" + this.params.length : "?";
  }

  toString(): string {
    return this.text;
  }
}
