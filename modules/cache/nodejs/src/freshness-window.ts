import { durationMs } from "@telorun/sdk";

/** A freshness window slot in milliseconds, zero when omitted; refuses anything that is not a duration. */
export function windowMs(value: unknown, describe: string): number {
  if (value === undefined) return 0;
  const ms = durationMs(value);
  if (ms === undefined) throw new Error(`${describe} must be a duration`);
  return ms;
}
