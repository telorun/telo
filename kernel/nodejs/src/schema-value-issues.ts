/**
 * A schema refusal in the value-issue vocabulary — what every `ERR_INPUT_INVALID` /
 * `ERR_OUTPUT_INVALID` a schema raised carries as `data.issues`, so a caller (a
 * transport answering an HTTP 400, a `catches:` entry) can say where a value failed
 * without parsing the message. A value is never quoted: the pointer, the keyword
 * and its params say where and what.
 */
import { valueIssue, type ValueIssue } from "@telorun/sdk";
import type { SchemaIssue } from "@telorun/analyzer";
import { SchemaValidationError } from "./schema-validator.js";

/** One finding: a value type that does not read is `format`, a missing property
 *  `required`, anything else `invalid` — the validator's sentence stays in the
 *  message. */
export function schemaValueIssue(issue: SchemaIssue): ValueIssue {
  const pointer = issue.pointer ?? "";
  if (issue.keyword === "x-telo-type" && issue.valueType) {
    return valueIssue(pointer, "format", { format: issue.valueType });
  }
  if (issue.keyword === "required") {
    return valueIssue(pointer, "required", { missingProperty: issue.missingProperty });
  }
  return valueIssue(pointer, undefined);
}

/** The `data` a refusal raised from `cause` carries: its issues when the cause is a
 *  schema refusal, else nothing. */
export function schemaRefusalData(cause: unknown): { issues: ValueIssue[] } | undefined {
  return cause instanceof SchemaValidationError ? { issues: cause.issues.map(schemaValueIssue) } : undefined;
}
