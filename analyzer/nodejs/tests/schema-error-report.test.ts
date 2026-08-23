import { describe, expect, it } from "vitest";
import { createAjv } from "../src/schema-compat.js";
import { formatAjvErrors, schemaIssues } from "../src/schema-error-report.js";

/** A pdfmake-shaped node union: branches discriminated by which key is present,
 *  each declaring that key as `required` — the obligation the carrier owes. */
const NODE = {
  $id: "test://node",
  anyOf: [
    {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" }, style: { type: "string" } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["table"],
      properties: {
        table: {
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "array" },
            headerRows: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["stack"],
      properties: { stack: { type: "array", items: { $ref: "test://node" } } },
      additionalProperties: false,
    },
  ],
};

function errorsFor(value: unknown): any[] {
  const ajv = createAjv();
  const validate = ajv.compile(NODE);
  expect(validate(value)).toBe(false);
  return validate.errors ?? [];
}

/** The shape a large vocabulary is actually written in: a branch per `$defs`
 *  entry, so AJV reports each branch under the TARGET's schemaPath and the
 *  branch index never appears in an error. */
const REF_NODE = {
  $id: "test://ref-node",
  anyOf: [
    { $ref: "#/$defs/Text" },
    { $ref: "#/$defs/Table" },
    { $ref: "#/$defs/List" },
  ],
  $defs: {
    Text: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    Table: {
      type: "object",
      required: ["table"],
      properties: {
        table: {
          type: "object",
          required: ["body"],
          properties: { body: { type: "array" }, headerRows: { type: "integer" } },
        },
      },
    },
    List: { type: "object", required: ["ul"], properties: { ul: { type: "array" } } },
  },
};

describe("union reduction with $ref branches", () => {
  function refErrors(value: unknown): any[] {
    const ajv = createAjv();
    ajv.addSchema(REF_NODE);
    const validate = ajv.compile({
      type: "object",
      properties: { content: { type: "array", items: { $ref: "test://ref-node" } } },
    });
    expect(validate({ content: [value] })).toBe(false);
    return validate.errors ?? [];
  }

  it("selects the branch that matched, though no error carries a branch index", () => {
    const message = formatAjvErrors(refErrors({ table: { body: "not-an-array" } }));
    expect(message).toBe("/content/0/table/body must be array");
  });

  it("keeps every complaint about the branch it selected", () => {
    const issues = schemaIssues(refErrors({ table: { body: "x", headerRows: "1" } }));
    expect(issues.map((i) => i.message).sort()).toEqual([
      "/content/0/table/body must be array",
      "/content/0/table/headerRows must be integer",
    ]);
  });

  it("names each alternative separately when none matched", () => {
    const message = formatAjvErrors(refErrors({ paragraph: "x" }));
    expect(message).toContain("matches no alternative");
    expect(message).toContain("'text'");
    expect(message).toContain("'table'");
    expect(message).toContain("'ul'");
  });
});

describe("union reduction", () => {
  it("reports only the branch whose discriminating key is present", () => {
    const message = formatAjvErrors(errorsFor({ table: { body: [], headerRow: 1 } }));
    expect(message).toContain("'headerRow' is not allowed");
    expect(message).not.toContain("'text'");
    expect(message).not.toContain("'stack'");
  });

  it("reduces at every level of a nested union, not just the outermost", () => {
    const message = formatAjvErrors(errorsFor({ stack: [{ text: 42 }] }));
    expect(message).toContain("/stack/0/text must be string");
    expect(message).not.toContain("'table'");
    // The inner union's own alternatives must not survive either.
    expect(message.split(";")).toHaveLength(1);
  });

  it("lists the alternatives when no branch is a plausible reading", () => {
    const message = formatAjvErrors(errorsFor({ paragraph: "hello" }));
    expect(message).toContain("matches no alternative");
    expect(message).toContain("'text'");
    expect(message).toContain("'table'");
    expect(message).toContain("'stack'");
  });

  it("anchors the alternatives error at the union node, not at any branch", () => {
    const issues = schemaIssues(errorsFor({ stack: [{ paragraph: "x" }] }));
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("stack[0]");
  });

  it("narrows the error SET, so one union failure is one diagnostic", () => {
    expect(schemaIssues(errorsFor({ text: 42 }))).toHaveLength(1);
  });

  it("leaves a non-union failure exactly as it was", () => {
    const ajv = createAjv();
    const validate = ajv.compile({
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    });
    validate({});
    expect(formatAjvErrors(validate.errors)).toBe("/ is missing required property 'a'");
  });
});

describe("a deeply nested recursive union", () => {
  /** Containers recursing through the union root, the shape a document tree
   *  has. Both halves of reduction scale with depth here — the occurrence set
   *  and the error set — and this runs on the editor's per-keystroke path. */
  const DEEP = {
    $id: "test://deep",
    anyOf: [
      { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string" } } },
      {
        type: "object",
        required: ["stack"],
        additionalProperties: false,
        properties: { stack: { type: "array", items: { $ref: "test://deep" } } },
      },
    ],
  };

  function nest(depth: number, leaf: unknown): unknown {
    let node = leaf;
    for (let i = 0; i < depth; i++) node = { stack: [node] };
    return node;
  }

  function deepErrors(value: unknown): any[] {
    const ajv = createAjv();
    ajv.addSchema(DEEP);
    const validate = ajv.compile({ $ref: "test://deep" });
    expect(validate(value)).toBe(false);
    return validate.errors ?? [];
  }

  it("reports the innermost fault once, whatever the depth", () => {
    for (const depth of [1, 4, 12]) {
      const issues = schemaIssues(deepErrors(nest(depth, { text: 42 })));
      const path = `${"stack[0].".repeat(depth)}text`;
      expect(issues).toEqual([{ path, message: `/${"stack/0/".repeat(depth)}text must be string` }]);
    }
  });

  it("names the alternatives at the innermost node, not at every level", () => {
    const issues = schemaIssues(deepErrors(nest(6, { paragraph: "x" })));
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("stack[0].".repeat(6).replace(/\.$/, ""));
    expect(issues[0].message).toContain("matches no alternative");
  });
});
