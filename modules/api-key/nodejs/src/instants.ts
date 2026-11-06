import {
  celDurationFromNanos,
  celTimestampFromMillis,
  isCelDuration,
  isCelTimestamp,
  timestampNanos,
  type CelDuration,
  type CelTimestamp,
} from "@telorun/sdk";

export function timestampOfMillis(millis: number): CelTimestamp {
  const value = celTimestampFromMillis(millis);
  if (!isCelTimestamp(value)) throw new RangeError(`${millis} is not an instant a timestamp can hold`);
  return value;
}

export function millisOfTimestamp(value: CelTimestamp): number {
  return Number(timestampNanos(value) / 1_000_000n);
}

export function durationOfMillis(millis: number): CelDuration {
  const value = celDurationFromNanos(BigInt(Math.round(millis)) * 1_000_000n);
  if (!isCelDuration(value)) throw new RangeError(`${millis} ms is not a duration`);
  return value;
}
