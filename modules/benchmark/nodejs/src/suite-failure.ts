import { boundedSample, truncate } from "./error-sample.js";
import { MAX_MESSAGE_LENGTH, MAX_SAMPLE_LENGTH } from "./error-groups.js";

export const VALIDATE_FALSE_CODE = "VALIDATE_FALSE";

export interface ClassifiedFailure {
  code: string;
  message: string;
  sample: string;
}

/** A thrown failure groups by its `code` (else its name) and message; the sample is its data. */
export function classifyThrown(error: unknown): ClassifiedFailure {
  if (error instanceof Error) {
    const carried = error as Error & { code?: unknown; data?: unknown };
    return {
      code: typeof carried.code === "string" ? carried.code : error.name,
      message: truncate(error.message, MAX_MESSAGE_LENGTH),
      sample: boundedSample(carried.data, MAX_SAMPLE_LENGTH),
    };
  }
  return { code: "Error", message: truncate(String(error), MAX_MESSAGE_LENGTH), sample: "" };
}

/** A `validate` that is not `true` groups under one code; the result's `status` names the cases. */
export function classifyValidateFailure(result: unknown): ClassifiedFailure {
  const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : undefined;
  const status = record?.status;
  const message =
    typeof status === "number" || typeof status === "bigint" || typeof status === "string"
      ? `validate returned false: status ${status}`
      : "validate returned false";
  const carried = record && "body" in record ? record.body : result;
  return { code: VALIDATE_FALSE_CODE, message, sample: boundedSample(carried, MAX_SAMPLE_LENGTH) };
}
