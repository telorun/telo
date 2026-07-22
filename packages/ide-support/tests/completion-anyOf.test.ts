import { describe, expect, it } from "vitest";
import { detectContext, lookupRefConstraint, navigateSchema } from "../src/completions/detect-context.js";

/** A schema that mimics the shape of an `x-telo-ref` slot: the property
 *  itself has no `properties` of its own — the object form lives inside an
 *  `anyOf` branch. Without anyOf peeling, completion at the slot returns
 *  nothing. Mirrors `Http.Api.routes[].handler` / `Run.Sequence.steps[].invoke`. */
const refSlotParent = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          invoke: {
            "x-telo-ref": "telo#Invocable",
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  name: { type: "string" },
                  inputs: { type: "object" },
                },
              },
            ],
          },
        },
      },
    },
  },
};

describe("navigateSchema — anyOf/oneOf peeling for ref slots", () => {
  it("surfaces the object-branch properties of an x-telo-ref slot", () => {
    const node = navigateSchema(refSlotParent, ["steps", "invoke"]);
    expect(node).toBeDefined();
    expect(node!.properties).toBeDefined();
    expect(Object.keys(node!.properties)).toEqual(
      expect.arrayContaining(["kind", "name", "inputs"]),
    );
  });

  it("merges properties across multiple object branches (oneOf form)", () => {
    const schema = {
      type: "object",
      properties: {
        handler: {
          oneOf: [
            { type: "string" },
            { type: "object", properties: { kind: { type: "string" } } },
            { type: "object", properties: { ref: { type: "string" } } },
          ],
        },
      },
    };
    const node = navigateSchema(schema, ["handler"]);
    expect(node!.properties).toBeDefined();
    expect(Object.keys(node!.properties)).toEqual(
      expect.arrayContaining(["kind", "ref"]),
    );
  });

  it("descends into anyOf branches mid-path to reach a nested property", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: { inner: { type: "object", properties: { leaf: { type: "string" } } } },
            },
          ],
        },
      },
    };
    const node = navigateSchema(schema, ["outer", "inner"]);
    expect(node!.properties).toEqual({ leaf: { type: "string" } });
  });
});

describe("lookupRefConstraint", () => {
  it("reads the x-telo-ref string at the navigated slot", () => {
    expect(lookupRefConstraint(refSlotParent, ["steps", "invoke"])).toBe("telo#Invocable");
  });

  it("preserves x-telo-ref when navigateSchema unions multiple oneOf branches", () => {
    const schema = {
      type: "object",
      properties: {
        handler: {
          "x-telo-ref": "telo#Invocable",
          oneOf: [
            { type: "string" },
            { type: "object", properties: { kind: { type: "string" } } },
          ],
        },
      },
    };
    expect(lookupRefConstraint(schema, ["handler"])).toBe("telo#Invocable");
  });

  it("returns undefined when the slot has no x-telo-ref", () => {
    const schema = {
      type: "object",
      properties: { port: { type: "integer" } },
    };
    expect(lookupRefConstraint(schema, ["port"])).toBeUndefined();
  });
});

describe("detectContext — indented kind", () => {
  it("returns kind ctx with docKind+yamlPath for indented kind lines", () => {
    const text = [
      "kind: Run.Sequence",
      "metadata:",
      "  name: Foo",
      "steps:",
      "  - name: s1",
      "    invoke:",
      "      kind: ",
    ].join("\n");
    // Cursor at end of last line — column is end of "      kind: ".
    const line = 6;
    const character = text.split("\n")[line].length;
    const ctx = detectContext(text, line, character);
    expect(ctx).toBeDefined();
    expect(ctx!.type).toBe("kind");
    if (ctx!.type === "kind") {
      expect(ctx.docKind).toBe("Run.Sequence");
      expect(ctx.yamlPath).toEqual(["steps", "invoke"]);
    }
  });

  it("returns plain kind ctx (no docKind) for top-level kind lines", () => {
    const ctx = detectContext("kind: ", 0, 6);
    expect(ctx).toEqual({
      type: "kind",
      replaceRange: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 6 },
      },
    });
  });
});
