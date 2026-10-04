import { describe, expect, it } from "vitest";
import { integerInput } from "../src/bigint-json.js";
import { celUint } from "../src/cel-value-identity.js";

describe("integerInput", () => {
  it("reads a CEL uint as a number, and refuses one past the safe range", () => {
    expect(integerInput(celUint(42n))).toBe(42);
    expect(integerInput(celUint(2n ** 60n))).toBeUndefined();
  });
});
