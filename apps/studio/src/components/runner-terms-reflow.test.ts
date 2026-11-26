import { describe, expect, it } from "vitest";
import { reflowRunnerTerms } from "./runner-terms-reflow";

describe("reflowRunnerTerms", () => {
  it("joins wrapped lines, splits paragraphs and lists", () => {
    const body = [
      "Do not use this runner for",
      "real user data.",
      "",
      "You agree that:",
      "- sessions are deleted after",
      "  seven days;",
      "* nothing is guaranteed.",
      "",
      "Thanks.",
    ].join("\n");
    expect(reflowRunnerTerms(body)).toEqual([
      { kind: "paragraph", text: "Do not use this runner for real user data." },
      { kind: "paragraph", text: "You agree that:" },
      { kind: "list", items: ["sessions are deleted after seven days;", "nothing is guaranteed."] },
      { kind: "paragraph", text: "Thanks." },
    ]);
  });

  it("returns nothing for an empty body", () => {
    expect(reflowRunnerTerms("  \n\n")).toEqual([]);
  });
});
