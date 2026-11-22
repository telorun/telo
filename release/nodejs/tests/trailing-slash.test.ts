import { describe, expect, it } from "vitest";
import { simpleIndexFiles } from "../src/adapters/pypi.js";
import { normalizeUnitKey } from "../src/fragment.js";
import { trimTrailingSlashes } from "../src/trailing-slash.js";

describe("trimTrailingSlashes", () => {
  it("drops every trailing slash and nothing else", () => {
    expect(trimTrailingSlashes("https://r.example/a//")).toBe("https://r.example/a");
    expect(trimTrailingSlashes("/a/b")).toBe("/a/b");
    expect(trimTrailingSlashes("///")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
  });

  it("normalizes a unit key written three ways to one", () => {
    expect(normalizeUnitKey(".\\apps\\web\\")).toBe("apps/web");
    expect(normalizeUnitKey("./apps/web//")).toBe("apps/web");
  });
});

describe("simpleIndexFiles", () => {
  it("reads an anchor's text without its tags and keeps a stray '<'", () => {
    const body = `<a href="x-1.tar.gz#sha256=ab">x-<b>1</b>.tar.gz</a><a href="y">a < b</a>`;
    expect(simpleIndexFiles(body, false, "idx").map((f) => f.filename)).toEqual(["x-1.tar.gz", "a < b"]);
  });
});
