import { describe, expect, it } from "vitest";
import { fittingUnionBranches } from "../src/schema-compat.js";

/** A union's branches selected by the `const` / `enum` pins a written literal
 *  falls outside, beside `type` and `required`. */
const titlesOf = (
  schema: Record<string, any>,
  data: unknown,
  external?: (ref: string) => Record<string, any> | undefined,
) => fittingUnionBranches(schema, data, schema, external)?.map((branch) => branch.title);

const cel = (source: string) => ({ __tagged: true, engine: "cel", source });

// The shape of a node tree tagged on `type`: `text` / `badge` share a branch.
const node = {
  type: "object",
  oneOf: [
    { title: "text", required: ["type", "text"], properties: { type: { enum: ["text", "badge"] } } },
    { title: "link", required: ["type", "text", "href"], properties: { type: { const: "link" } } },
    { title: "command", required: ["type", "command", "text"], properties: { type: { const: "command" } } },
    { title: "bar", required: ["type"], properties: { type: { const: "bar" } } },
  ],
};

describe("union branch selection by pins", () => {
  it("selects the one branch a `const` tag names", () => {
    const schema = {
      oneOf: [
        { title: "a", required: ["type"], properties: { type: { const: "a" } } },
        { title: "b", required: ["type"], properties: { type: { const: "b" } } },
      ],
    };
    expect(titlesOf(schema, { type: "b" })).toEqual(["b"]);
  });

  it("selects the one branch an `enum` tag holds", () => {
    expect(titlesOf(node, { type: "badge", text: "New" })).toEqual(["text"]);
  });

  it("no longer fits a `link` or a `command` node to the `text` branch", () => {
    expect(titlesOf(node, { type: "link", text: "Home", href: "/" })).toEqual(["link"]);
    expect(titlesOf(node, { type: "command", text: "Stop", command: cel("chat.stop") })).toEqual(["command"]);
  });

  it("reads a branch-level `enum` for a scalar", () => {
    const schema = { anyOf: [{ title: "mode", enum: ["a", "b"] }, { title: "other", type: "string" }] };
    expect(titlesOf(schema, "c")).toEqual(["other"]);
  });

  it("reads a tag declared through a `$ref`", () => {
    const shape = { $id: "telo:M/Tag", const: "one" };
    const schema = {
      $defs: { Two: { const: "two" } },
      oneOf: [
        { title: "one", required: ["type"], properties: { type: { $ref: "telo:M/Tag" } } },
        { title: "two", required: ["type"], properties: { type: { $ref: "#/$defs/Two" } } },
      ],
    };
    const external = (ref: string) => (ref === shape.$id ? shape : undefined);
    expect(titlesOf(schema, { type: "two" }, external)).toEqual(["two"]);
    expect(titlesOf(schema, { type: "one" }, external)).toEqual(["one"]);
  });

  it("reads a tag declared as an `anyOf` of constants", () => {
    const schema = {
      oneOf: [
        { title: "ab", required: ["type"], properties: { type: { anyOf: [{ const: "a" }, { const: "b" }] } } },
        { title: "c", required: ["type"], properties: { type: { const: "c" } } },
      ],
    };
    expect(titlesOf(schema, { type: "b" })).toEqual(["ab"]);
  });

  it("fits a branch that is itself a union when one of its branches fits", () => {
    const schema = {
      oneOf: [
        {
          title: "shapes",
          oneOf: [
            { required: ["type"], properties: { type: { const: "circle" } } },
            { required: ["type"], properties: { type: { const: "square" } } },
          ],
        },
        { title: "line", required: ["type"], properties: { type: { const: "line" } } },
      ],
    };
    expect(titlesOf(schema, { type: "square" })).toEqual(["shapes"]);
    expect(titlesOf(schema, { type: "line" })).toEqual(["line"]);
  });

  it("reads a pin in a branch's `allOf` part", () => {
    const schema = {
      oneOf: [
        { title: "a", allOf: [{ required: ["type"] }, { properties: { type: { const: "a" } } }] },
        { title: "b", allOf: [{ required: ["type"] }, { properties: { type: { const: "b" } } }] },
      ],
    };
    expect(titlesOf(schema, { type: "b" })).toEqual(["b"]);
  });

  it("reads a pin on the union's shared base under the branch's own", () => {
    const schema = {
      type: "object",
      properties: { mode: { enum: ["fast", "safe"] } },
      oneOf: [
        { title: "fast", required: ["mode"], properties: { mode: { const: "fast" } } },
        { title: "safe", required: ["mode"], properties: { mode: { const: "safe" } } },
      ],
    };
    expect(titlesOf(schema, { mode: "safe" })).toEqual(["safe"]);
  });

  it("compares by JSON Schema equality", () => {
    const schema = {
      oneOf: [
        { title: "string", required: ["v"], properties: { v: { const: "true" } } },
        { title: "boolean", required: ["v"], properties: { v: { const: true } } },
        { title: "number", required: ["v"], properties: { v: { const: 1.0 } } },
      ],
    };
    expect(titlesOf(schema, { v: true })).toEqual(["boolean"]);
    expect(titlesOf(schema, { v: 1 })).toEqual(["number"]);
  });

  it("leaves the union ambiguous when the tag is an expression", () => {
    expect(titlesOf(node, { type: cel("'bar'"), text: "x" })).toEqual(["text", "bar"]);
  });
});
