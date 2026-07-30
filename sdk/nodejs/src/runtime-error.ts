export interface RuntimeDiagnostic {
  severity?: "error" | "warning";
  message: string;
  resource?: string;
  kind?: string;
  details?: string;
  code?: string;
  /** Set when this entry failed ONLY because another resource in the same
   *  failure set did — it carries no independent cause. Renderers collapse
   *  these into one line rather than repeating one failure per dependent. */
  derived?: boolean;
  /** When `derived`, the ROOT of the dependency chain — the resource a reader
   *  has to fix. Absent when the blocker could not be named. */
  blockedBy?: string;
  /** Diagnostics from a nested context (an import's own resource init), kept
   *  structured instead of flattened into `message` so the classification and
   *  the error count see the real leaves. */
  children?: RuntimeDiagnostic[];
}

/** Well-known kernel error codes. User-defined codes (e.g. from Type.JsonSchema rules) are also valid. */
export type RuntimeErrorCode =
  | "ERR_RESOURCE_NOT_FOUND"
  | "ERR_RESOURCE_NOT_RUNNABLE"
  | "ERR_CONTROLLER_NOT_FOUND"
  | "ERR_CONTROLLER_INVALID"
  | "ERR_RESOURCE_INITIALIZATION_FAILED"
  | "ERR_RESOURCE_NOT_INVOKABLE"
  | "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED"
  | "ERR_DUPLICATE_RESOURCE"
  | "ERR_EXECUTION_FAILED"
  | "ERR_INVALID_VALUE"
  | "ERR_VISIBILITY_DENIED"
  | "ERR_MANIFEST_VALIDATION_FAILED"
  | "ERR_CIRCULAR_DEPENDENCY"
  | "ERR_SCOPE_RESOURCE_NOT_FOUND"
  | "ERR_TYPE_NOT_FOUND"
  | "ERR_TYPE_VALIDATION_FAILED"
  | "ERR_KERNEL_STATE_INVALID"
  | "ERR_LOCAL_REF_PENDING"
  | "ERR_CROSS_MODULE_REF_PENDING"
  | (string & {});
