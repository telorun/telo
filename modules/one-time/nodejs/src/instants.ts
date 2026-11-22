import { celTimestampFromMillis, isCelTimestamp, type CelTimestamp } from "@telorun/sdk";

export function timestampOfMillis(millis: number): CelTimestamp {
  const value = celTimestampFromMillis(millis);
  if (!isCelTimestamp(value)) throw new RangeError(`${millis} is not an instant a timestamp can hold`);
  return value;
}
