import { describe, expect, it } from "vitest";
import { valueIssue } from "../src/issue-keywords.js";

describe("valueIssue", () => {
  it("keeps a vocabulary keyword with only the params its entry names", () => {
    expect(valueIssue("/body/note", "maxLength", { limit: 5, extra: "dropped" })).toEqual({
      pointer: "/body/note",
      keyword: "maxLength",
      params: { limit: 5 },
    });
  });

  it("writes a keyword outside the vocabulary as invalid, with no params", () => {
    expect(valueIssue("/body", "anyOf", { passingSchemas: null })).toEqual({
      pointer: "/body",
      keyword: "invalid",
      params: {},
    });
  });
});
