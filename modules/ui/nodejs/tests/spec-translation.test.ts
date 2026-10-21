import type { TextRecord } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { SpecTranslator } from "../src/spec-translation.js";

const RECORD = {
  "x-telo-fragment": "TextRecord",
  type: "object",
  additionalProperties: false,
  required: ["text", "context", "lang", "computed"],
  properties: { text: {}, context: {}, lang: { type: "string" }, computed: { type: "boolean" } },
};

/** The parts of `Ui.SpecNode` a walk reads, as the registry holds them. */
const root = {
  type: "object",
  oneOf: [
    {
      additionalProperties: false,
      required: ["type", "children"],
      properties: { type: { enum: ["box", "stack"] }, children: { type: "array", items: { $ref: "#" } } },
    },
    {
      additionalProperties: false,
      required: ["type", "text"],
      properties: { type: { enum: ["text"] }, text: { $ref: "#/$defs/NodeText" } },
    },
    {
      additionalProperties: false,
      required: ["type", "schema", "labels"],
      properties: {
        type: { const: "value" },
        schema: { type: "object" },
        labels: { $ref: "#/$defs/Labels" },
      },
    },
  ],
  $defs: {
    Text: { anyOf: [RECORD, { $ref: "#/$defs/Word" }] },
    NodeText: { anyOf: [{ $ref: "#/$defs/Text" }, { $ref: "#/$defs/BoundText" }] },
    BoundText: {
      type: "object",
      additionalProperties: false,
      required: ["text", "values"],
      properties: { text: RECORD, values: { type: "object", additionalProperties: {} } },
    },
    Word: { type: "object", additionalProperties: false, required: ["word"], properties: { word: { enum: ["loading"] } } },
    Labels: {
      type: "array",
      items: { type: "object", properties: { value: {}, label: { $ref: "#/$defs/Text" } } },
    },
  },
};

const record = (text: string): TextRecord => ({ text, context: null, lang: "en", computed: false });
const translator = new SpecTranslator({ root, resolve: () => undefined }, (r) => ({ translated: r.text }));

describe("a node's texts", () => {
  it("are translated where the schema types a text, a text with values carrying its values beside it", () => {
    const node = {
      type: "stack",
      children: [
        { type: "text", text: record("Hello") },
        { type: "text", text: { text: record("{$n} items"), values: { n: { root: "data", path: ["count"] } } } },
        { type: "text", text: { word: "loading" } },
      ],
    };
    expect(translator.node(node)).toEqual({
      type: "stack",
      children: [
        { type: "text", text: { translated: "Hello" } },
        { type: "text", text: { translated: "{$n} items", values: { n: { root: "data", path: ["count"] } } } },
        { type: "text", text: { word: "loading" } },
      ],
    });
  });

  it("leave a data member alone, even one shaped like a text", () => {
    const shaped = { text: "x", context: null, lang: "en", computed: false };
    const node = { type: "value", schema: { properties: { a: shaped } }, labels: [{ value: "open", label: record("Open") }] };
    expect(translator.node(node)).toEqual({
      type: "value",
      schema: { properties: { a: shaped } },
      labels: [{ value: "open", label: { translated: "Open" } }],
    });
  });
});
