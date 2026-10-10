import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// `system` is one shape, `SystemPrompt`: a string, or a non-empty list of
// `ContentPart` narrowed to text. The four operations' input contracts name it
// by reference; their resource fields hold it written inline, with the text
// part written out. This holds each copy to the shape and to `ContentPart`.

const docs = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), {
  logLevel: "silent",
}).map((doc) => doc.toJS());

const named = (kind: string, name: string) =>
  docs.find((doc) => doc?.kind === kind && doc.metadata?.name === name);

describe("the system prompt of an operation's resource field", () => {
  const shape = named("Telo.JsonSchema", "SystemPrompt").schema;
  const part = named("Telo.JsonSchema", "ContentPart").schema;
  const [text, list] = shape.anyOf;

  it("is declared by the shape as a string or a list of ContentPart narrowed to text", () => {
    expect(Object.keys(shape)).toEqual(["anyOf"]);
    expect(shape.anyOf).toHaveLength(2);
    expect(list.items).toEqual({
      allOf: [{ $ref: "telo:AI/ContentPart" }, { properties: { type: { const: "text" } } }],
    });
  });

  it.each(["Text", "TextStream", "Agent", "AgentStream"])("is that shape on %s", (kind) => {
    const { title, description, ...field } = named("Telo.Definition", kind).schema.properties.system;
    expect(Object.keys(field)).toEqual(["anyOf"]);
    expect(field.anyOf).toHaveLength(2);
    expect(field.anyOf[0]).toEqual(text);

    const { items, ...copy } = field.anyOf[1];
    const { items: narrowed, ...declared } = list;
    expect(copy).toEqual(declared);

    // The written-out text part: ContentPart's own members for a text part.
    const textBranch = part.anyOf.find(
      (branch: { properties: { type: { const?: string } } }) => branch.properties.type.const === "text",
    );
    expect(part.properties.type.enum).toContain(items.properties.type.const);
    expect(items.properties.type).toEqual(textBranch.properties.type);
    expect(items.required).toEqual(textBranch.required);
    expect(items.type).toBe(part.type);
    expect(items.additionalProperties).toBe(part.additionalProperties);
    expect(Object.keys(items.properties)).toEqual(["type", "text", "cacheBreakpoint"]);
    expect(items.properties.text.type).toBe(part.properties.text.type);
    expect(items.properties.cacheBreakpoint.type).toBe(part.properties.cacheBreakpoint.type);
  });
});
