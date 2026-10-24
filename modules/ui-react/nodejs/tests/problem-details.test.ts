import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ISSUE_WORDS, issueWord, type Issue } from "../src/browser/problem-details.js";
import { formatWord } from "../src/browser/texts.js";
import { validate } from "../src/browser/validation.js";
import { englishWords } from "./words.js";

const directory = new URL("../../../../sdk/issue-keywords/", import.meta.url);
const vocabulary = readdirSync(directory)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(new URL(file, directory), "utf8")) as { keyword: string; params: string[] });

const said = (issue: Issue) => {
  const word = issueWord(issue);
  return formatWord(englishWords, word.id, word.values);
};

describe("a validation issue of a problem", () => {
  it("is worded for every keyword of the vocabulary, and only those", () => {
    expect(Object.keys(ISSUE_WORDS).sort()).toEqual(vocabulary.map(({ keyword }) => keyword).sort());
    for (const { keyword, params } of vocabulary) {
      const issue = { pointer: "/body/a", keyword, params: Object.fromEntries(params.map((name) => [name, name === "limit" ? 2 : "x"])) };
      expect(issueWord(issue).id, keyword).toBe(keyword);
      expect(said(issue), keyword).not.toBe("");
    }
  });

  it.each([
    [{ keyword: "type", params: { type: "integer" } }, { type: "integer" }, 1.5],
    [{ keyword: "enum", params: { allowedValues: ["a", 2] } }, { enum: ["a", 2] }, "c"],
    [{ keyword: "const", params: { allowedValue: "on" } }, { const: "on" }, "off"],
    [{ keyword: "multipleOf", params: { multipleOf: 0.1 } }, { multipleOf: 0.1 }, 0.25],
  ])("reads as the browser's own validation reads the same keyword: %j", (issue, schema, value) => {
    const [finding] = validate(schema, value);
    expect(said({ pointer: "/body", ...issue })).toBe(formatWord(englishWords, finding.word.id, finding.word.values));
  });

  it("reads a keyword outside the vocabulary as invalid", () => {
    expect(issueWord({ pointer: "/body/a", keyword: "dependentRequired", params: {} })).toEqual({ id: "invalid" });
  });
});
