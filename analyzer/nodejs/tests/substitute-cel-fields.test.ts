import type { CompiledValue } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { substituteDecodedCelFields } from "../src/plain-literal-decoding.js";
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
    expect(substituteCelFields({ when: { __tagged: true, engine: "cel", source: "size(result.rows) > 0" } }, booleanSlot)).toEqual({
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

  /** A literal at a slot that holds an instance is read from the type's plain
   *  encoding, exactly as the kernel reads it at creation — and text a TAG
   *  produced is not a literal: the kernel decodes before an embed resolves, so
   *  a file's contents are never read as an encoding. */
  it("decodes a literal at an instance slot, on a copy, and never an embed's text", () => {
    const schema = { type: "object", properties: { at: { "x-telo-type": "Telo.Timestamp" } } };
    const written = { at: "2026-01-15T09:30:00Z" };
    expect(substituteDecodedCelFields(written, schema, undefined)).toEqual({
      at: new Date("2026-01-15T09:30:00Z"),
    });
    expect(written).toEqual({ at: "2026-01-15T09:30:00Z" });
    // Left as text, so the slot's own assertion refuses it.
    expect(substituteDecodedCelFields({ at: "tomorrow" }, schema, undefined)).toEqual({
      at: "tomorrow",
    });
    expect(
      substituteDecodedCelFields({ at: makeTaggedSentinel("include-text", "./at.txt") }, schema, undefined),
    ).toEqual({ at: "" });
  });

  /** Decoding is a property of the SITE, not of the walk: a caller checking a
   *  slot the kernel never decodes — a definition's `result:` mapping, produced
   *  at dispatch — must see the text the author wrote, or it accepts a manifest
   *  the runtime then rejects. */
  it("leaves a literal at an instance slot alone when the site does not decode", () => {
    const schema = { type: "object", properties: { at: { "x-telo-type": "Telo.Timestamp" } } };
    expect(substituteCelFields({ at: "2026-01-15T09:30:00Z" }, schema)).toEqual({
      at: "2026-01-15T09:30:00Z",
    });
  });
});
