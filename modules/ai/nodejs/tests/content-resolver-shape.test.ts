import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// `resolver` is one shape, ContentResolver, which each of the four operations
// references. This holds the part shapes in it — the `part` a mapping reads and
// the part `result` gives — to ContentPart, which it cannot reference: a
// binding and a slot are typed from a schema written where they are declared.

const docs = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), {
  logLevel: "silent",
}).map((doc) => doc.toJS());

const named = (kind: string, name: string) =>
  docs.find((doc) => doc?.kind === kind && doc.metadata?.name === name);

const OPERATIONS = ["Text", "TextStream", "Agent", "AgentStream"];

describe("an operation's content resolver", () => {
  const resolver = named("Telo.JsonSchema", "ContentResolver").schema;
  const part = named("Telo.JsonSchema", "ContentPart").schema;

  it.each(OPERATIONS)("is the ContentResolver shape on %s", (kind) => {
    expect(named("Telo.Definition", kind).schema.properties.resolver.$ref).toBe(
      "telo://Self/ContentResolver",
    );
  });

  it("types `part` as a media part by reference, with ContentPart's own members", () => {
    const bound = resolver.properties.inputs["x-telo-context"].properties.part;
    const media = part.anyOf.find(
      (branch: { properties: { type: { enum?: string[] } } }) =>
        branch.properties.type.enum?.includes("image"),
    );
    expect(bound.properties.type.enum).toEqual(media.properties.type.enum);
    expect(Object.keys(bound.properties)).toEqual(["type", "uri", "mediaType", "name", "cacheBreakpoint"]);
    for (const member of ["uri", "mediaType", "name", "cacheBreakpoint"]) {
      expect(bound.properties[member]).toEqual({ type: part.properties[member].type });
    }
  });

  it("gives a part a caller may send, with ContentPart's own members", () => {
    const answer = resolver.properties.result;
    const { ["x-telo-context"]: context, title, description, properties, anyOf, ...shape } = answer;
    expect(shape).toEqual({ type: "object", additionalProperties: false, required: ["type"] });
    const sendable = part.anyOf.filter(
      (branch: { properties: { type: { const?: string; enum?: string[] } } }) =>
        branch.properties.type.const === "text" || branch.properties.type.enum?.includes("image"),
    );
    expect(anyOf).toEqual(sendable);
    expect(properties.type.enum).toEqual(
      part.properties.type.enum.filter((type: string) => !["tool-call", "reasoning", "citation", "refusal"].includes(type)),
    );
    expect(properties.data).toEqual({ anyOf: part.properties.data.anyOf });
    for (const member of ["text", "mediaType", "name", "cacheBreakpoint"]) {
      expect(properties[member]).toEqual({ type: part.properties[member].type });
    }
    expect(properties.uri).toEqual({ type: part.properties.uri.type, allOf: part.properties.uri.allOf });
    expect(Object.keys(properties).sort()).toEqual(
      ["type", "text", "data", "uri", "mediaType", "name", "cacheBreakpoint"].sort(),
    );
  });
});
