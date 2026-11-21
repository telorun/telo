/**
 * The code the load refusal rule raises a static code under — the one mapping
 * from what `telo check` reports to what a kernel raises at load, read by the
 * rule's every group and by the need table, so one failure has one runtime code
 * wherever it is raised. Twin: `analyzer/rust/src/load_refusal_code.rs`.
 */

/** The static codes a kernel raises under a name of their own. */
const RUNTIME_CODE_EXCEPTIONS: Readonly<Record<string, string>> = {
  DUPLICATE_RESOURCE_NAME: "ERR_DUPLICATE_RESOURCE",
  SCHEMA_VIOLATION: "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
  UNRESOLVED_REFERENCE: "ERR_REF_UNRESOLVED",
};

/** The runtime code of the static `code`: its exception, else `ERR_<code>`. */
export function runtimeCodeOf(code: string): string {
  return RUNTIME_CODE_EXCEPTIONS[code] ?? `ERR_${code}`;
}
