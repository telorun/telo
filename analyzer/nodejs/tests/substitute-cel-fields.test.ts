import type { CompiledValue } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { substituteCelFields } from "../src/schema-compat.js";

/** An expression reaches this walk in three spellings — a `${{ … }}` string, a
 *  `!cel` sentinel, and the CompiledValue `precompileDoc` produces under
 *  `compile: true`. A caller seeing only the first two hands the third to AJV as
 *  a plain object, so one manifest validates under `telo check` and fails under
 *  `telo run`, on a slot the author wrote correctly. */
const compiled = (source: string): CompiledValue =>
  ({ __compiled: true, source, call: () => undefined }) as CompiledValue;

describe("substituteCelFields", () => {
  const booleanSlot = { type: "object", properties: { when: { type: "boolean" } } };

  it("substitutes a boolean placeholder for an inline expression", () => {
    expect(substituteCelFields({ when: "${{ size(result.rows) > 0 }}" }, booleanSlot)).toEqual({
      when: false,
    });
  });

  it("substitutes a boolean placeholder for a COMPILED expression", () => {
    expect(substituteCelFields({ when: compiled("size(result.rows) > 0") }, booleanSlot)).toEqual({
      when: false,
    });
  });

  it("places a compiled expression by the slot it sits at, not by its own shape", () => {
    const schema = { type: "object", properties: { port: { type: "integer", minimum: 1 } } };
    expect(substituteCelFields({ port: compiled("ports.http") }, schema)).toEqual({ port: 1 });
  });
});
