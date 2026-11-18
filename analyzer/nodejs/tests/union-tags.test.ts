import { describe, expect, it } from "vitest";
import { formatAjvErrors } from "../src/schema-error-report.js";
import { judgedFindings } from "./judged-validation.js";

const tagged = (type: unknown, extra: Record<string, unknown> = {}) => ({
  type: "object",
  required: ["type"],
  properties: { type, ...extra },
});

describe("a union is read by the tags its candidates share", () => {
  const schema = {
    oneOf: [
      { type: "string" },
      tagged({ const: "text" }, { text: { type: "string" } }),
      tagged({ enum: ["button", "link"] }, { label: { type: "string" } }),
    ],
  };

  it("reports a wrong tag once, at the tag, listing both values, and never as a string", () => {
    const findings = judgedFindings(schema, { type: "txt" });
    expect(findings.map((f) => [f.keyword, f.instancePath, f.params])).toEqual([
      ["enum", "/type", { allowedValues: ["text", "button", "link"] }],
    ]);
    expect(formatAjvErrors(findings)).toBe(
      "/type must be equal to one of the allowed values (text | button | link)",
    );
  });

  it("reports a defect beneath the nested tag it selects", () => {
    const nested = { type: "object", properties: { root: schema } };
    expect(formatAjvErrors(judgedFindings(nested, { root: { type: "text", text: 1 } }))).toBe(
      "/root/text must be string",
    );
    expect(formatAjvErrors(judgedFindings(nested, { root: { type: "nope" } }))).toBe(
      "/root/type must be equal to one of the allowed values (text | button | link)",
    );
  });

  it("decides among the candidates accepting the tag when several do", () => {
    const shared = {
      anyOf: [
        tagged({ const: "a" }, { n: { type: "string" } }),
        tagged({ const: "b" }),
        tagged({ const: "a" }, { n: { type: "integer" } }),
      ],
    };
    expect(formatAjvErrors(judgedFindings(shared, { type: "a", n: true }))).toBe(
      "/n must be string; /n must be integer",
    );
  });

  it("lists the alternatives where no branch admits the value's JSON type", () => {
    const findings = judgedFindings({ anyOf: [{ type: "string" }, { type: "integer" }] }, {});
    expect(findings.map((f) => [f.keyword, f.instancePath])).toEqual([["anyOf", ""]]);
    expect(formatAjvErrors(findings)).toBe("/ matches no alternative — expected a string, or a integer");
  });

  it("takes no constant under items for a tag", () => {
    const parts = {
      anyOf: [
        { type: "string" },
        { type: "array", items: { type: "object", properties: { type: { const: "text" } } } },
        { type: "array", items: { type: "object", properties: { type: { const: "media" } } } },
      ],
    };
    // Both array branches fail beneath `items`, reporting one line between them;
    // neither tag-refuses the node.
    expect(formatAjvErrors(judgedFindings(parts, [{ type: "x" }]))).toBe("/0/type must be equal to constant");
  });

  it("reads a tag through a reference and an allOf", () => {
    const shapes = {
      "test://tag": { properties: { type: { const: "x" } } },
    };
    const viaRefs = {
      anyOf: [
        { type: "object", allOf: [{ $ref: "test://tag" }], properties: { x: { type: "string" } } },
        { type: "object", properties: { type: { const: "y" }, y: { type: "string" } } },
      ],
    };
    const findings = judgedFindings(viaRefs, { type: "z" }, { shapes });
    expect(findings.map((f) => [f.keyword, f.instancePath, f.params])).toEqual([
      ["enum", "/type", { allowedValues: ["x", "y"] }],
    ]);
  });
});

describe("a union is read by the selectors its candidates pin", () => {
  const record = {
    type: "object",
    required: ["key"],
    anyOf: [
      { required: ["store"], properties: { store: { type: "string" } } },
      { required: ["address"], properties: { address: { const: true } } },
    ],
  };

  it("lists a required member a candidate pins to a constant among the alternatives", () => {
    const findings = judgedFindings(record, { key: "k", address: false });
    expect(findings.map((f) => [f.keyword, f.instancePath])).toEqual([["anyOf", ""]]);
    expect(formatAjvErrors(findings)).toBe(
      "/ matches no alternative — expected one with 'store', or one with 'address' equal to true",
    );
  });

  it("reports inside the branch the other member selects", () => {
    expect(formatAjvErrors(judgedFindings(record, { key: "k", address: false, store: 5 }))).toBe("/store must be string");
  });

  it("lists an enum selector with its values", () => {
    const schema = {
      anyOf: [
        { required: ["file"] },
        { required: ["mode"], properties: { mode: { enum: ["a", "b"] } } },
      ],
    };
    expect(formatAjvErrors(judgedFindings(schema, { mode: "z" }))).toBe(
      "/ matches no alternative — expected one with 'file', or one with 'mode' one of a | b",
    );
  });

  it("reports a member nothing requires as the failure it is", () => {
    const schema = {
      anyOf: [{ required: ["file"], properties: { mode: { enum: ["a", "b"] } } }, { required: ["url"] }],
    };
    expect(formatAjvErrors(judgedFindings(schema, { file: "f", mode: "z" }))).toBe(
      "/mode must be equal to one of the allowed values (a | b)",
    );
  });

  it("reads no selector with a single candidate", () => {
    const schema = { anyOf: [{ type: "string" }, { required: ["a"], properties: { a: { const: 1 } } }] };
    expect(formatAjvErrors(judgedFindings(schema, { a: 2 }))).toBe("/a must be equal to constant");
  });
});
