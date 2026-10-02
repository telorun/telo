/**
 * Value identity: a string type key under `Symbol.for("telo.cel.value")`.
 *
 * What has to hold is that recognition depends on **nothing but the key** — not on a
 * constructor, not on a class this module owns — because two copies of the engine loaded
 * independently are two sets of classes and `instanceof` would refuse the other copy's
 * values. So the foreign values here are built **by hand**, from the registered symbol and
 * the documented shape, exactly as another copy would build them: that is the whole
 * contract, and a test that imported a second module instance would prove less, since both
 * instances share one symbol registry anyway.
 */
import { describe, expect, it } from "vitest";
import {
  CEL_VALUE_KEYS,
  CEL_VALUE_TYPE,
  CelEnvironment,
  celTypeNameOf,
  celUint,
  type CelValue,
} from "../src/index.js";

/** A value as another copy of the engine would hand it over. */
const foreign = {
  uint: { [Symbol.for("telo.cel.value")]: "uint", value: 7n },
  instant: { [Symbol.for("telo.cel.value")]: "google.protobuf.Timestamp", seconds: 1234567890n, nanos: 0 },
  span: { [Symbol.for("telo.cel.value")]: "google.protobuf.Duration", seconds: 90n, nanos: 0 },
};

function evaluateWith(source: string, activation: Record<string, unknown>): CelValue {
  return new CelEnvironment({ unlistedVariablesAreDyn: true }).evaluate(source, activation);
}

describe("the CEL value domain", () => {
  it("recognises a value built from the key alone, with no constructor of this module", () => {
    expect(celTypeNameOf(foreign.uint)).toBe("uint");
    expect(evaluateWith("type(held) == uint", { held: foreign.uint })).toBe(true);
    expect(evaluateWith("held + 1u", { held: foreign.uint })).toEqual(celUint(8n));
  });

  it("computes with an instant and a duration another copy would have built", () => {
    expect(evaluateWith("string(at + by)", { at: foreign.instant, by: foreign.span })).toBe(
      "2009-02-13T23:33:00Z",
    );
  });

  it("reads a plain object carrying a string-keyed look-alike brand as data, not as a uint", () => {
    const forged = { "telo.cel.value": "uint", value: "7" };
    expect(celTypeNameOf(forged)).toBe("map");
    expect(evaluateWith("type(held) == map", { held: forged })).toBe(true);
    expect(evaluateWith("held['telo.cel.value']", { held: forged })).toBe("uint");
  });

  it("refuses a host type whose name is a type key the engine's own values carry", () => {
    for (const key of CEL_VALUE_KEYS) {
      expect(() => new CelEnvironment().registerType({ name: key, base: "string" }), key).toThrow();
    }
  });

  it("answers the type of a value of a host's own named type, by the key it carries", () => {
    expect(celTypeNameOf({ [CEL_VALUE_TYPE]: "Money", amount: 5n })).toBe("Money");
  });
});
