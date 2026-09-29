import { describe, expect, it } from "vitest";
import type { ContentPart } from "../src/content.js";
import { boundToolContent } from "../src/tool-result-bound.js";

const image: ContentPart = { type: "image", data: "aGVsbG8=", mediaType: "image/png" };

describe("boundToolContent", () => {
  it("returns a result within the limit as the same value", () => {
    const parts: ContentPart[] = [{ type: "text", text: "abc" }, image, { type: "text", text: "de" }];
    expect(boundToolContent("héllo", 6)).toBe("héllo");
    expect(boundToolContent(parts, 5)).toBe(parts);
  });

  it("returns every result unchanged when no limit is set", () => {
    const long = "x".repeat(100_000);
    expect(boundToolContent(long, undefined)).toBe(long);
  });

  it("cuts a string at a code-point boundary and puts the marker on its own line", () => {
    // "ab" 2 bytes, "é" 2, "😀" 4 (a surrogate pair), "c" 1: 9 bytes in all.
    expect(boundToolContent("abé😀c", 7)).toBe(
      "abé\n[truncated: 5 of 9 bytes cut; a tool result passes at most 7 bytes to the model]",
    );
  });

  it("counts text parts in order, cuts the one the limit falls in and drops later text, keeping media in place", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "abcd" },
      image,
      { type: "text", text: "€€" },
      image,
      { type: "text", text: "tail" },
    ];
    // 4 + 6 + 4 = 14 bytes of text; 8 keeps "abcd" and one "€" (3 bytes of 4 left).
    expect(boundToolContent(parts, 8)).toEqual([
      { type: "text", text: "abcd" },
      image,
      { type: "text", text: "€" },
      image,
      {
        type: "text",
        text: "[truncated: 7 of 14 bytes cut; a tool result passes at most 8 bytes to the model]",
      },
    ]);
  });
});
