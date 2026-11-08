export type ComparisonCode =
  | "ERR_BENCHMARK_PLATFORM_UNSUPPORTED"
  | "ERR_BENCHMARK_BOOT_FAILED"
  | "ERR_BENCHMARK_STARTUP_SPAN_MISSING"
  | "ERR_BENCHMARK_COMPARISON_INVALID";

/** A refusal that ends the run; the controller raises it as a RuntimeError with its code. */
export class ComparisonFailure extends Error {
  constructor(
    readonly code: ComparisonCode,
    message: string,
  ) {
    super(message);
    this.name = "ComparisonFailure";
  }
}

/** `60s`, `1500ms`. */
export function formatDurationMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
