/** A precompiled template or expression produced by the analyzer.
 *  Replaces raw "${{ }}" strings in manifests at load time.
 *  The SDK has no knowledge of CEL — it only calls .call(). */
export interface CompiledValue {
  readonly __compiled: true;
  /** Original expression source text (e.g. "env.PORT"), if available. */
  readonly source?: string;
  /** For an interpolated string ("a ${{ x }} b"), the ordered literal
   *  fragments and embedded expression segments before they are joined into a
   *  single string by `call()`. Absent for a bare single expression. Consumers
   *  that need each interpolation as a separate value (e.g. SQL bind
   *  parameters) read this instead of the joined `call()` result. */
  readonly parts?: ReadonlyArray<string | CompiledValue>;
  /** Root variable identifiers the expression reads, extracted from the CEL AST
   *  at compile time (e.g. `["self", "request"]` for
   *  `self.table + request.id`). Lets consumers decide what scope an expression
   *  needs without re-parsing or string-matching the source. Absent for engines
   *  that don't surface an AST. */
  readonly refs?: readonly string[];
  call(ctx: Record<string, unknown>): unknown;
}

export function isCompiledValue(v: unknown): v is CompiledValue {
  return v !== null && typeof v === "object" && (v as any).__compiled === true;
}

/** The value a parameterized template (the `!sql` engine) evaluates to: literal
 *  text fragments plus the separately-evaluated value of each embedded `${{ }}`
 *  interpolation, with `fragments.length === values.length + 1`. A consumer emits
 *  its own placeholder between fragments and binds the values — never splicing
 *  them into the text. Single source of truth for the marker contract shared
 *  across the producing engine and any consuming controller. */
export interface ParameterizedSql {
  readonly __teloParameterized: true;
  readonly fragments: string[];
  readonly values: unknown[];
}

export function isParameterizedSql(v: unknown): v is ParameterizedSql {
  return (
    v !== null && typeof v === "object" && (v as any).__teloParameterized === true
  );
}
