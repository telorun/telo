import { withoutAbsentMembers } from "@telorun/sdk";

/** An error as data: its code when it carries one, its message, and its data. */
export interface RecordedError {
  code?: string;
  message: string;
  data?: unknown;
}

export function recordedError(err: unknown): RecordedError {
  const message = err instanceof Error ? err.message : String(err);
  const { code, data } = (err ?? {}) as { code?: unknown; data?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    message,
    ...(data !== undefined ? { data: withoutAbsentMembers(data) } : {}),
  };
}
