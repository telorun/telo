/** A precompiled template or expression produced by the analyzer.
 *  Replaces raw "${{ }}" strings in manifests at load time.
 *  The SDK has no knowledge of CEL — it only calls .call(). */
export interface CompiledValue {
  readonly __compiled: true;
  /** Original expression source text (e.g. "env.PORT"), if available. */
  readonly source?: string;
  call(ctx: Record<string, unknown>): unknown;
}

export function isCompiledValue(v: unknown): v is CompiledValue {
  return v !== null && typeof v === "object" && (v as any).__compiled === true;
}
