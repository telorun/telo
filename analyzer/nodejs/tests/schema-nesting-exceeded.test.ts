import { describe, expect, it } from "vitest";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { schemaNestingExceededSentence, unlessOverflow, VALUE_DEPTH_EXCEEDED } from "../src/schema-validation.js";

describe("a validation that cannot finish", () => {
  it("is what a value nested past the depth limit answers", () => {
    let step: Record<string, unknown> = { name: "leaf", value: 1 };
    for (let depth = 0; depth < 5000; depth++) step = { name: `s${depth}`, if: true, then: [step] };
    const steps = { type: "array", items: { $ref: "telo://manifest#/$defs/Step" } };
    expect(new DefinitionRegistry().validateResourceConfig([step], steps)).toEqual(VALUE_DEPTH_EXCEEDED);
  });

  it("is what the engine's own stack overflow answers, worded as the backstop", () => {
    const outcome = unlessOverflow(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    expect(outcome.finished).toBe(false);
    expect(outcome.finished ? undefined : schemaNestingExceededSentence("the value", outcome)).toBe(
      "the value cannot be validated — validating it nests past what this engine can follow: nest it less deeply.",
    );
  });
});
