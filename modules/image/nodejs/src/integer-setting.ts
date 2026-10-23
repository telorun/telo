import { InvokeError, integerInput } from "@telorun/sdk";

/** An integer input as the number it denotes: a YAML literal arrives as a number,
 *  a `!cel` one as an int64. */
export function integerSetting(value: unknown, owner: string, field: string): number {
  const integer = integerInput(value);
  if (integer === undefined) {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `${owner}: '${field}' must be an integer a number can hold, got ${String(value)}.`,
    );
  }
  return integer;
}
