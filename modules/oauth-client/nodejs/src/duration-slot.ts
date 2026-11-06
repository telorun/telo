import { durationMs } from "@telorun/sdk";

/** A `Telo.Duration` slot in milliseconds, `fallback` when omitted; refuses anything that is not a duration. */
export function slotMs(value: unknown, fallback: number, describe: string): number {
  if (value === undefined) return fallback;
  const ms = durationMs(value);
  if (ms === undefined) throw new Error(`${describe} must be a duration`);
  return ms;
}
