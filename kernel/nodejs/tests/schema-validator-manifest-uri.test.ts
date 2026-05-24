import { makeTaggedSentinel, MANIFEST_SCHEMA_URI } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { SchemaValidator } from "../src/schema-validator.js";

/** Pins the wiring that makes `$ref: "telo://manifest#/$defs/ResourceRef"`
 *  resolve in the kernel's `SchemaValidator` AJV instance. Without the
 *  `addSchema(ManifestRootSchema)` call inside the SchemaValidator
 *  constructor, AJV would throw at compile time with an unresolved-ref
 *  error — this test fails loudly if that registration goes missing. */
describe("SchemaValidator + telo://manifest", () => {
  it("compiles a module schema that $refs into the shared fragment", () => {
    const v = new SchemaValidator();
    const consumerSchema = {
      type: "object",
      properties: {
        target: { $ref: `${MANIFEST_SCHEMA_URI}#/$defs/ResourceRef` },
      },
      required: ["target"],
    };
    const validator = v.compile(consumerSchema);

    // The runtime contract: accepts a `!ref` tagged sentinel, rejects
    // shapes that don't match. We only care here that AJV could resolve
    // the $ref at compile time — both assertions exercise the compiled
    // path so a regression in URI registration surfaces.
    expect(
      validator.isValid({ target: makeTaggedSentinel("ref", "Something") }),
    ).toBe(true);
    expect(
      validator.isValid({ target: { __tagged: true, engine: "cel", source: "x" } }),
    ).toBe(false);
  });
});
