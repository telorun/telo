import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { toToolContent } from "../src/agent-tools.js";
import { DECLARED_KEYS } from "../src/content.js";

// What a tool returned is carried to the model as content parts only when it IS
// content parts, by the shape `Ai.ContentPart` declares; anything else is data
// and is written as JSON.

describe("a tool's result as message content", () => {
  it("carries a media part by bytes or by URI, alone or in a list", () => {
    const byUri = { type: "image", mediaType: "image/png", uri: "https://example.com/a.png" };
    const byBytes = {
      type: "file",
      mediaType: "application/pdf",
      name: "report.pdf",
      data: new Uint8Array([1]),
    };
    expect(toToolContent(byUri)).toEqual([byUri]);
    expect(toToolContent([{ type: "text", text: "rendered" }, byBytes])).toEqual([
      { type: "text", text: "rendered" },
      byBytes,
    ]);
  });

  it("carries a part marking a cache breakpoint, on the parts a caller sends", () => {
    const marked = [
      { type: "text", text: "the manual", cacheBreakpoint: true },
      { type: "file", mediaType: "application/pdf", name: "a.pdf", data: "aGk=", cacheBreakpoint: true },
    ];
    expect(toToolContent(marked)).toEqual(marked);
    expect(toToolContent(marked[0])).toEqual([marked[0]]);
  });

  it.each([
    ["a cache breakpoint on a part a model produces", { type: "reasoning", text: "hm", cacheBreakpoint: true }],
    ["a cache breakpoint that is not a boolean", { type: "text", text: "hi", cacheBreakpoint: "yes" }],
    ["neither bytes nor a URI", { type: "image", mediaType: "image/png" }],
    ["both", { type: "image", mediaType: "image/png", data: "aGk=", uri: "https://example.com/a.png" }],
    ["no media type", { type: "file", uri: "https://example.com/a.pdf" }],
    ["a data: URI", { type: "image", mediaType: "image/png", uri: "DATA:image/png;base64,aGk=" }],
    ["a relative URI", { type: "file", mediaType: "application/pdf", uri: "reports/a.pdf" }],
    [
      "a key the shape does not declare",
      { type: "image", mediaType: "image/png", data: "aGk=", cacheControl: { type: "ephemeral" } },
    ],
    ["a key of the wrong type", { type: "file", mediaType: "application/pdf", data: "aGk=", name: 7 }],
    ["an undeclared key on a text part", { type: "text", text: "hi", width: 3 }],
  ])("writes a value with %s as JSON, since it is not a part", (name, value) => {
    expect(toToolContent(value)).toBe(JSON.stringify(value));
  });

  it("is recognised by exactly the keys Ai.ContentPart declares", () => {
    const manifest = readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8");
    const shape = parseAllDocuments(manifest, { logLevel: "silent" })
      .map((doc) => doc.toJS())
      .find((doc) => doc?.kind === "Telo.JsonSchema" && doc.metadata?.name === "ContentPart");
    expect(Object.keys(DECLARED_KEYS).sort()).toEqual(Object.keys(shape.schema.properties).sort());
  });
});
