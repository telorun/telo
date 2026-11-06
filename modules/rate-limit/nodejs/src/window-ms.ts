import { durationMs } from "@telorun/sdk";

/** A `window` slot in milliseconds; refuses anything that is not a duration. */
export function windowMs(value: unknown, describe: string): number {
  const ms = durationMs(value);
  if (ms === undefined) throw new Error(`${describe}: 'window' must be a duration`);
  return ms;
}
