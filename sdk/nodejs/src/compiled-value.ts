/** A precompiled template or expression produced by the analyzer.
 *  Replaces a tagged scalar (`!cel`, `!interpolate`, `!sql`) at load time.
 *  The SDK has no knowledge of CEL — it only calls .call(). */
export interface CompiledValue {
  readonly __compiled: true;
  /** Original expression source text (e.g. "env.PORT"), if available. */
  readonly source?: string;
  /** Root variable identifiers the expression reads, extracted from the CEL AST
   *  at compile time (e.g. `["self", "request"]` for
   *  `self.table + request.id`). Lets consumers decide what scope an expression
   *  needs without re-parsing or string-matching the source. Absent for engines
   *  that don't surface an AST. */
  readonly refs?: readonly string[];
  /** Qualified module calls the expression makes (`["Billing.format",
   *  "Self.y"]`), as written, extracted from the CEL AST at compile time.
   *
   *  A call whose receiver is one of the declaring module's names is a call on
   *  another resource, so it is a dependency the expression states — the same
   *  standing `refs` has, one namespace out. Carried on the value because
   *  re-deriving it needs the module's name set, which a consumer holding an
   *  expression does not have: a re-parse cannot tell `Billing.format(x)` from a
   *  method call on a variable named `Billing`. Absent for an engine that
   *  surfaces no AST; empty for an expression that calls nothing qualified. */
  readonly calls?: readonly string[];
  /** Each qualified call the expression makes, with how every argument is
   *  WRITTEN: its value when it is literals alone, else `literal: false`. Read
   *  where a parameter takes only a value fixed at the call site (a `Text`
   *  parameter), which the value the call evaluates to cannot say. Absent for an
   *  engine that surfaces no AST; empty for an expression that calls nothing
   *  qualified. */
  readonly callArguments?: readonly CompiledCall[];
  /** True when the expression calls a catalog function whose result differs
   *  per evaluation (`uuidv4()`, `nowMillis()`), so it must never be evaluated
   *  once and reused — even where it reads nothing but constants. */
  readonly volatile?: true;
  call(ctx: Record<string, unknown>): unknown;
}

/** One qualified call of a compiled expression, with how its arguments are written. */
export interface CompiledCall {
  readonly qualified: string;
  readonly arguments: readonly (
    | { readonly literal: true; readonly value: unknown }
    | { readonly literal: false }
  )[];
}

export function isCompiledValue(v: unknown): v is CompiledValue {
  return v !== null && typeof v === "object" && (v as any).__compiled === true;
}

/** The value a parameterized template (the `!sql` engine) evaluates to: literal
 *  text fragments plus the separately-evaluated value of each `${{ }}` hole, with `fragments.length === values.length + 1`. A consumer emits
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
