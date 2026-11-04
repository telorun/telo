import { durationMs, RuntimeError } from "@telorun/sdk";

/** A `Telo.Duration` setting in milliseconds, `fallback` when it is unset. */
export function durationSetting(value: unknown, fallback: number, describe: () => string): number {
  if (value === undefined || value === null) return fallback;
  const ms = durationMs(value);
  if (ms === undefined) {
    throw new RuntimeError("ERR_INVALID_VALUE", `${describe()} must be a duration.`);
  }
  return ms;
}
