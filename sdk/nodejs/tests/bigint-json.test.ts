import { describe, expect, it } from "vitest";
import { integerInput } from "../src/bigint-json.js";
import { UnsignedInt } from "../src/cel-value-identity.js";

describe("integerInput", () => {
  it("reads a CEL uint as a number, and refuses one past the safe range", () => {
    expect(integerInput(new UnsignedInt(42))).toBe(42);
    expect(integerInput(new UnsignedInt(2n ** 60n))).toBeUndefined();
  });
});
