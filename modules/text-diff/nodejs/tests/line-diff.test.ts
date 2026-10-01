import { describe, expect, it } from "vitest";
import { lineDiff, type Hunk } from "../src/line-diff.js";

/** `before` with every hunk applied — what a valid diff must turn into `after`. */
function apply(before: string, hunks: Hunk[]): string {
  const source = before === "" ? [] : before.split("\n");
  if (before.endsWith("\n")) source.pop();
  const out: string[] = [];
  let next = 0;
  let endsWithNewline = before === "" || before.endsWith("\n");
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    out.push(...source.slice(next, start));
    next = start + hunk.oldLines;
    for (const line of hunk.lines) {
      if (line.op === "removed") continue;
      out.push(line.text);
      endsWithNewline = line.noNewline !== true;
    }
  }
  out.push(...source.slice(next));
  return out.length === 0 ? "" : out.join("\n") + (endsWithNewline ? "\n" : "");
}

describe("a comparison past the edit cap", () => {
  it("still returns a diff that turns `before` into `after`", () => {
    const lines = (prefix: string) =>
      Array.from({ length: 40 }, (_, index) => `${prefix}${index}`).join("\n") + "\n";
    const before = `head\n${lines("old")}tail\n`;
    const after = `head\n${lines("new")}tail\n`;

    const capped = lineDiff(before, after, { contextLines: 1, maxInputBytes: 262144, maxEditLength: 10 });
    expect(capped.comparable).toBe(true);
    expect({ added: capped.added, removed: capped.removed }).toEqual({ added: 40, removed: 40 });
    expect(apply(before, capped.hunks!)).toBe(after);
  });
});
