import { describe, expect, it } from "vitest";
import { applyPatch } from "../src/apply-patch.js";

const options = { maxInputBytes: 262144 };
const refusal = (code: string, section: number | null, lines: number[] | null = null) => ({
  applied: false,
  text: null,
  code,
  section,
  lines,
});

describe("applyPatch", () => {
  it("applies sections in order, each seeing the earlier results", () => {
    const patch = [
      "<<<<<<< SEARCH", "one", "=======", "ONE", ">>>>>>> REPLACE",
      "<<<<<<< SEARCH", "ONE", "=======", "uno", ">>>>>>> REPLACE",
      "<<<<<<< SEARCH", "two", "=======", "dos", ">>>>>>> REPLACE",
    ].join("\n") + "\n";
    expect(applyPatch("one\ntwo\n", patch, options)).toEqual({
      applied: true,
      text: "uno\ndos\n",
      code: null,
      section: null,
      lines: null,
    });
  });

  it("matches whole lines and deletes them with an empty REPLACE", () => {
    const patch = "<<<<<<< SEARCH\nb\n=======\n>>>>>>> REPLACE\n";
    expect(applyPatch("a\nb\nc\n", patch, options)).toMatchObject({ applied: true, text: "a\nc\n" });
  });

  it("refuses a search that does not occur, naming its section", () => {
    const patch = [
      "<<<<<<< SEARCH", "a", "=======", "A", ">>>>>>> REPLACE",
      "<<<<<<< SEARCH", "missing", "=======", "x", ">>>>>>> REPLACE",
    ].join("\n") + "\n";
    expect(applyPatch("a\nb\n", patch, options)).toEqual(refusal("EDIT_SECTION_ABSENT", 2));
  });

  it("refuses an ambiguous search with the line of every match", () => {
    const patch = "<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n";
    expect(applyPatch("x\na\nx\n", patch, options)).toEqual(refusal("EDIT_SECTION_AMBIGUOUS", 1, [1, 3]));
  });

  it("counts overlapping matches as matches", () => {
    const patch = "<<<<<<< SEARCH\na\na\n=======\nb\n>>>>>>> REPLACE\n";
    expect(applyPatch("a\na\na\n", patch, options)).toEqual(refusal("EDIT_SECTION_AMBIGUOUS", 1, [1, 2]));
  });

  it("judges a later section against the text the earlier ones left", () => {
    const patch = [
      "<<<<<<< SEARCH", "a", "=======", "x", ">>>>>>> REPLACE",
      "<<<<<<< SEARCH", "a", "=======", "y", ">>>>>>> REPLACE",
    ].join("\n") + "\n";
    expect(applyPatch("a\nq\n", patch, options)).toEqual(refusal("EDIT_SECTION_ABSENT", 2));
  });

  it("refuses an empty SEARCH as malformed", () => {
    const patch = "<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n";
    expect(applyPatch("a\n", patch, options)).toEqual(refusal("EDIT_BLOCK_MALFORMED", 1));
  });

  it("refuses text before the first marker, and text after the last", () => {
    const section = "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n";
    expect(applyPatch("a\n", "stray\n" + section, options)).toEqual(refusal("EDIT_BLOCK_MALFORMED", null));
    expect(applyPatch("a\n", section + "stray\n", options)).toEqual(refusal("EDIT_BLOCK_MALFORMED", null));
  });

  it("refuses a missing divider and a missing closing marker, naming the section", () => {
    expect(applyPatch("a\n", "<<<<<<< SEARCH\na\nb\n", options)).toEqual(refusal("EDIT_BLOCK_MALFORMED", 1));
    expect(applyPatch("a\n", "<<<<<<< SEARCH\na\n=======\nb\n", options)).toEqual(refusal("EDIT_BLOCK_MALFORMED", 1));
  });

  it("refuses an empty patch as malformed", () => {
    expect(applyPatch("a\n", "", options)).toEqual(refusal("EDIT_BLOCK_MALFORMED", null));
  });

  it("matches CRLF text only with a CRLF search", () => {
    const lf = "<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n";
    const crlf = "<<<<<<< SEARCH\r\na\r\n=======\r\nA\r\n>>>>>>> REPLACE\r\n";
    expect(applyPatch("a\r\nb\r\n", lf, options)).toEqual(refusal("EDIT_SECTION_ABSENT", 1));
    expect(applyPatch("a\r\nb\r\n", crlf, options)).toMatchObject({ applied: false, code: "EDIT_BLOCK_MALFORMED" });
  });

  it("applies a CRLF search to CRLF text", () => {
    const patch = "<<<<<<< SEARCH\na\r\n=======\nA\r\n>>>>>>> REPLACE\n";
    expect(applyPatch("a\r\nb\r\n", patch, options)).toMatchObject({ applied: true, text: "A\r\nb\r\n" });
  });

  it("matches the last line of a text with no final newline", () => {
    const patch = "<<<<<<< SEARCH\nb\n=======\nc\n>>>>>>> REPLACE\n";
    expect(applyPatch("a\nb", patch, options)).toEqual({ applied: true, text: "a\nc", code: null, section: null, lines: null });
  });

  it("deletes the last line of a text with no final newline, leaving the previous line unterminated", () => {
    const patch = "<<<<<<< SEARCH\nb\n=======\n>>>>>>> REPLACE\n";
    expect(applyPatch("a\nb", patch, options)).toMatchObject({ applied: true, text: "a" });
  });

  it("keeps lines a REPLACE adds at the end of a text with no final newline unterminated", () => {
    const patch = "<<<<<<< SEARCH\nb\n=======\nc\nd\n>>>>>>> REPLACE\n";
    expect(applyPatch("a\nb", patch, options)).toMatchObject({ applied: true, text: "a\nc\nd" });
  });

  it("reports ambiguous matches in a text with no final newline by their own lines", () => {
    const patch = "<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n";
    expect(applyPatch("x\na\nx", patch, options)).toEqual(refusal("EDIT_SECTION_AMBIGUOUS", 1, [1, 3]));
  });

  it("does not match an empty text against a line feed it does not hold", () => {
    const patch = "<<<<<<< SEARCH\n\n=======\nx\n>>>>>>> REPLACE\n";
    expect(applyPatch("", patch, options)).toEqual(refusal("EDIT_SECTION_ABSENT", 1));
  });

  it("refuses an input over maxInputBytes without a section", () => {
    const patch = "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n";
    expect(applyPatch("a".repeat(17), patch, { maxInputBytes: 16 })).toEqual(refusal("EDIT_BLOCK_MALFORMED", null));
    expect(applyPatch("a\n", "x".repeat(17), { maxInputBytes: 16 })).toEqual(refusal("EDIT_BLOCK_MALFORMED", null));
  });
});
