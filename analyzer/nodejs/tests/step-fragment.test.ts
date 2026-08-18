import { describe, expect, it } from "vitest";
import {
  expandManifestFragments,
  manifestFragmentOf,
  MANIFEST_SCHEMA_URI,
} from "../src/manifest-schemas.js";
import { readStepSlot } from "../src/step-slot.js";

/** A kind declaring a step body, as an author writes it. */
function definitionWithSteps(): Record<string, any> {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Transaction" },
    schema: {
      type: "object",
      properties: {
        steps: {
          title: "Steps",
          "x-telo-topology-role": "steps",
          type: "array",
          items: { $ref: `${MANIFEST_SCHEMA_URI}#/$defs/Step` },
        },
      },
    },
  };
}

describe("the Step fragment", () => {
  it("localizes and hoists into the schema a validator compiles", () => {
    const doc = definitionWithSteps();
    expandManifestFragments(doc);

    // The slot points at a DOCUMENT-LOCAL pointer: the editor's resolver throws
    // on anything else, and the hoist target is the `schema:` node because that
    // is what AJV is handed.
    expect(doc.schema.properties.steps.items.$ref).toBe("#/$defs/telo:Step");
    expect(doc.schema.$defs["telo:Step"]).toBeDefined();
    expect(doc.schema.$defs["telo:Step"].oneOf.map((b: any) => b.title)).toEqual(
      expect.arrayContaining(["invoke", "if/then/else", "while/do", "try/catch/finally", "value"]),
    );
  });

  it("expands the non-recursive fragment the hoisted body references", () => {
    const doc = definitionWithSteps();
    expandManifestFragments(doc);

    // `Step`'s dispatch branch points at `InvokeStep`, which is NOT recursive
    // and so has no localized form. Left as written it would carry a foreign
    // `telo://manifest#/…` into a document the editor refuses to walk.
    const invoke = doc.schema.$defs["telo:Step"].oneOf.find((b: any) => b.title === "invoke");
    expect(invoke.$ref).toBeUndefined();
    expect(Object.keys(invoke.properties)).toEqual(
      expect.arrayContaining(["invoke", "inputs", "when", "retry"]),
    );
    // …and the retry policy it holds in turn.
    expect(invoke.properties.retry.$ref).toBeUndefined();
    expect(invoke.properties.retry.properties.attempts).toBeDefined();
  });

  it("is recognised through the derived stamp, with no annotation to write", () => {
    const doc = definitionWithSteps();
    expandManifestFragments(doc);

    expect(manifestFragmentOf(doc.schema.properties.steps.items)).toBe("Step");
    expect(readStepSlot(doc.schema.properties.steps)).toEqual({
      invoke: "invoke",
      outputType: "outputType",
      value: "value",
    });
  });

  it("keeps reading the legacy annotation, and lets it win", () => {
    // A published module names its own shape; the fragment says only which
    // grammar the items point at, so the annotation is the more specific claim.
    expect(
      readStepSlot({
        "x-telo-step-context": { invoke: "run", outputType: "outputType" },
        items: {},
      }),
    ).toEqual({ invoke: "run", outputType: "outputType" });
    expect(readStepSlot({ type: "array", items: { type: "object" } })).toBeUndefined();
  });
});
