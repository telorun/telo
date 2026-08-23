import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import type { ParsedResource, Selection } from "../../../model";
import {
  focusedProperty,
  railProperties,
  railSelection,
  summarizeValue,
} from "./property-rail";

const loopSchema = {
  type: "object",
  required: ["steps"],
  properties: {
    condition: { title: "Condition", type: "boolean" },
    maxIterations: { title: "Max Iterations", type: "integer" },
    catches: { title: "Catches", type: "array" },
    steps: { title: "Steps", "x-telo-topology-role": "steps", type: "array" },
    outputs: { title: "Outputs", type: "object" },
  },
};

const resource = {
  kind: "Run.Loop",
  name: "poll",
  fields: {},
} as unknown as ParsedResource;

describe("railProperties", () => {
  it("lists the kind's own properties in declaration order, minus what the view renders", () => {
    // Listing a field the canvas is drawing gives the reader two places to edit
    // one thing; the order is the author's, so the rail reads like the manifest.
    expect(railProperties(loopSchema, ["steps"]).map((p) => p.name)).toEqual([
      "condition",
      "maxIterations",
      "catches",
      "outputs",
    ]);
  });

  it("keeps an annotated field no view claims, rather than hiding it", () => {
    // The rule used to be "exclude anything carrying an x-telo-topology-role",
    // which is a GUESS that some view draws it. A kind annotating an array no
    // view supports would have had that field vanish from the rail and never
    // appear on a canvas — unreachable in the editor entirely.
    expect(railProperties(loopSchema).map((p) => p.name)).toContain("steps");
  });

  it("renders nothing beside a view that consumes every property", () => {
    // The form view IS the whole field form, so the rail disappears beside it
    // as a consequence rather than by a rule of its own.
    const all = Object.keys(loopSchema.properties);
    expect(railProperties(loopSchema, all)).toEqual([]);
  });

  it("carries the kind's required set through", () => {
    const schema = { required: ["a"], properties: { a: {}, b: {} } };
    expect(railProperties(schema).map((p) => [p.name, p.required])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("is empty for a kind that declares no properties", () => {
    expect(railProperties({ type: "object" })).toEqual([]);
  });
});

describe("railSelection", () => {
  it("scopes to the resource root with a one-property schema", () => {
    // NOT `/condition`: the detail panel's pointer form edits the OBJECT at the
    // pointer, so a pointer aimed at a scalar resolves to nothing and the panel
    // falls back to the whole resource. This shape works for every type alike.
    const [condition] = railProperties(loopSchema);
    expect(railSelection(resource, condition!)).toEqual({
      resource: { kind: "Run.Loop", name: "poll" },
      pointer: "",
      schema: {
        type: "object",
        properties: { condition: { title: "Condition", type: "boolean" } },
      },
    });
  });

  it("keeps a required property required once opened", () => {
    const property = { name: "a", schema: { type: "string" }, required: true };
    expect(railSelection(resource, property).schema.required).toEqual(["a"]);
  });
});

describe("focusedProperty", () => {
  const select = (schema: Record<string, unknown>, pointer = ""): Selection => ({
    resource: { kind: "Run.Loop", name: "poll" },
    pointer,
    schema,
  });

  it("reads the open property back off the selection", () => {
    const [condition] = railProperties(loopSchema);
    expect(focusedProperty(railSelection(resource, condition!), resource)).toBe("condition");
  });

  it("claims nothing for a selection that is not one of its own", () => {
    // A step's `inputs` form, another resource's property, a whole-resource
    // form: none of them is a rail row, so none of them lights one up.
    expect(focusedProperty(select({ properties: { a: {} } }, "/steps/0"), resource)).toBeNull();
    expect(focusedProperty(select({ properties: { a: {}, b: {} } }), resource)).toBeNull();
    expect(focusedProperty(null, resource)).toBeNull();
    const other = { ...select({ properties: { a: {} } }), resource: { kind: "X", name: "y" } };
    expect(focusedProperty(other, resource)).toBeNull();
  });
});

describe("summarizeValue", () => {
  it("says what is there without pretending to be the value", () => {
    expect(summarizeValue(undefined)).toBe("not set");
    expect(summarizeValue(null)).toBe("null");
    expect(summarizeValue(10)).toBe("10");
    expect(summarizeValue(false)).toBe("false");
    expect(summarizeValue([1, 2, 3])).toBe("3 entries");
    expect(summarizeValue([1])).toBe("1 entry");
    expect(summarizeValue({ a: 1, b: 2 })).toBe("a, b");
    expect(summarizeValue({})).toBe("empty");
  });

  it("shows an expression verbatim — it is what the author wrote", () => {
    expect(summarizeValue(makeTaggedSentinel("cel", "previous == null"))).toBe("previous == null");
    expect(summarizeValue(makeTaggedSentinel("ref", "server"))).toBe("server");
  });
});
