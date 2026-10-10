import { describe, expect, it } from "vitest";
import { buildUnclassifiedSchema, getStepSchema, resolveRef } from "./schema-utils";

describe("resolveRef", () => {
  const root = { $defs: { Page: { type: "object", title: "Page" } } };

  it("follows a document-local reference", () => {
    expect(resolveRef({ $ref: "#/$defs/Page" }, root)).toBe(root.$defs.Page);
  });

  it("returns a schema carrying no reference as it is", () => {
    const schema = { type: "string" };
    expect(resolveRef(schema, root)).toBe(schema);
  });

  it("answers undefined for a local reference naming nothing", () => {
    expect(resolveRef({ $ref: "#/$defs/Missing" }, root)).toBeUndefined();
  });

  // What `UiReact.App` declares for a page's children. Throwing here took the
  // whole editor down from inside the graph's render.
  it("answers undefined for a shape another module declares", () => {
    expect(resolveRef({ $ref: "telo://Ui/Node" }, root)).toBeUndefined();
    expect(resolveRef({ $ref: "telo://manifest#/$defs/Step" }, root)).toBeUndefined();
  });
});

describe("a kind schema reaching a shape in another module", () => {
  const kindSchema = {
    type: "object",
    properties: {
      children: {
        type: "array",
        "x-telo-topology-role": "steps",
        items: { $ref: "telo://Ui/Node" },
      },
    },
  };

  it("has no step schema to offer", () => {
    expect(getStepSchema(kindSchema)).toBeNull();
  });

  it("keeps a field it cannot resolve as the reference it is", () => {
    const step = { properties: { node: { $ref: "telo://Ui/Node" } } };
    expect(buildUnclassifiedSchema(step, kindSchema)).toEqual({
      type: "object",
      properties: { node: { $ref: "telo://Ui/Node" } },
    });
  });
});
