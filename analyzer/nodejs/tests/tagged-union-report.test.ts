import { describe, expect, it } from "vitest";
import { DefinitionRegistry } from "../src/definition-registry.js";

/**
 * A TAGGED union — closed branches, each pinning `type` — reached through a
 * named shape that recurses on itself. The tag says which branch a node is, so
 * a failure is read as that branch's, at that node, at any depth.
 */
const NODE_ID = "telo:Test/Node";
const NODE = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "text"],
      properties: { type: { const: "text" }, text: { type: "string" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "children"],
      properties: {
        type: { const: "stack" },
        children: { type: "array", items: { $ref: "#" } },
      },
    },
    {
      // Two tags of one shape.
      type: "object",
      additionalProperties: false,
      required: ["type", "label"],
      properties: { type: { enum: ["button", "link"] }, label: { type: "string" } },
    },
  ],
};

const KIND_SCHEMA = {
  type: "object",
  required: ["root"],
  additionalProperties: false,
  properties: { root: { $ref: NODE_ID } },
};

function issues(root: unknown) {
  const defs = new DefinitionRegistry();
  expect(defs.registerNamedTypeSchema(NODE_ID, NODE)).toBe(true);
  return defs
    .validateResourceConfig({ root }, KIND_SCHEMA)
    .map((issue) => [issue.path, issue.message]);
}

const stack = (...children: unknown[]) => ({ type: "stack", children });

describe("a tagged union's failure", () => {
  it("lists the valid tags for a misspelled one, at the tag", () => {
    expect(issues(stack({ type: "txt", text: "hi" }))).toEqual([
      [
        "root.children[0].type",
        "/root/children/0/type must be equal to one of the allowed values (text | stack | button | link)",
      ],
    ]);
  });

  it("names a stray key on the node whose tag is right", () => {
    expect(issues(stack({ type: "link", label: "Home", href: "/" }))).toEqual([
      [
        "root.children[0]",
        "/root/children/0 must NOT have additional properties ('href' is not allowed)",
      ],
    ]);
  });

  it("reports a missing required key as the matching branch's", () => {
    expect(issues(stack(stack({ type: "text" })))).toEqual([
      [
        "root.children[0].children[0].text",
        "/root/children/0/children/0 is missing required property 'text'",
      ],
    ]);
  });
});
