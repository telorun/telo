export interface RuntimeDiagnostic {
  severity?: "error" | "warning";
  message: string;
  resource?: string;
  code?: string;
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
  | (string & {});
