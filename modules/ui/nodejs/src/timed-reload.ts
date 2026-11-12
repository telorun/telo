import { durationMs } from "@telorun/sdk";

/** A reader's or a listing's `reloadEvery` as the renderer receives it: milliseconds, absent when unset. */
export function reloadEveryOf(value: unknown): { reloadEvery?: number } {
  const ms = value == null ? undefined : durationMs(value);
  return ms === undefined ? {} : { reloadEvery: ms };
}
