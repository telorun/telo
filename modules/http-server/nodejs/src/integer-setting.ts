import { integerInput } from "@telorun/sdk";

/** An integer the manifest configures, as the number it denotes: a YAML literal
 *  arrives as a number, a `!cel` one as an int64. */
export function integerSetting(value: unknown, owner: string, field: string): number {
  const integer = integerInput(value);
  if (integer === undefined) {
    throw new Error(`${owner}: '${field}' must be an integer a number can hold, got ${String(value)}.`);
  }
  return integer;
}
