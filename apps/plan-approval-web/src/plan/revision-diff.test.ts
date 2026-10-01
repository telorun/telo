import { describe, expect, it } from "vitest";

import { itemBlocks, itemIdOfLine } from "@/plan/item-grammar";
import { itemSummary, lineDiff } from "@/plan/revision-diff";

describe("itemIdOfLine", () => {
  it("reads the server's item grammar", () => {
    const lines = [
      "## S1 Build it",
      "- **C2**: check",
      "3. AB12 ship",
      "* D4",
      "S1 not a heading",
      "- lower c1",
      "## Notes",
      "- S1x glued",
    ];
    expect(lines.map(itemIdOfLine)).toEqual(["S1", "C2", "AB12", "D4", undefined, undefined, undefined, undefined]);
  });
});

describe("itemBlocks", () => {
  it("runs an item to the next item or heading", () => {
    const body = "# Plan\n## S1 Build\ndetail\n\n- C1 check\n## Notes\ntext";
    expect([...itemBlocks(body)]).toEqual([
      ["S1", "## S1 Build\ndetail"],
      ["C1", "- C1 check"],
    ]);
  });
});

describe("fenced code", () => {
  it("declares no item, so a block repeating an ID changes that item's text only", () => {
    const base = "## S1 Upload\n\n```bash\n# S1 bucket setup\n```\n\n~~~yaml\n- S3 is not an item\n~~~\n- C4 after";
    expect([...itemBlocks(base).keys()]).toEqual(["S1", "C4"]);
    expect(itemSummary(base, base.replace("# S1 bucket setup", "# S9 bucket teardown"))).toEqual({
      added: [],
      removed: [],
      changed: ["S1"],
    });
  });
});

describe("fence shapes", () => {
  const ids = (body: string) => [...itemBlocks(body).keys()];

  it("reads a block indented under a list item as fenced", () => {
    expect(ids("- S1 Upload\n  - detail\n    ```bash\n    # S1 bucket setup\n    ```\n- C4 after")).toEqual(["S1", "C4"]);
  });

  it("reads a CRLF body as it reads an LF one", () => {
    expect(ids("## S1 Upload\r\n\r\n```bash\r\n# S9 comment\r\n```\r\n\r\n## S2\r\n- C4 after\r\n")).toEqual(["S1", "S2", "C4"]);
  });

  it("closes a fence only on at least as many of its character", () => {
    const body = "## S1 Docs\n\n````markdown\n```\n- S8 inside\n```\n````\n\n## S2 Next\n- C3 thing";
    expect(ids(body)).toEqual(["S1", "S2", "C3"]);
  });

  it("opens nothing at a line starting with an inline code span", () => {
    expect(ids("## S1 Docs\n```x``` is a span\n- C2 after")).toEqual(["S1", "C2"]);
  });

  it("runs an unterminated fence to the end", () => {
    expect(ids("## S1 Docs\n~~~\n- C2 inside")).toEqual(["S1"]);
  });
});

describe("lineDiff", () => {
  it("numbers kept, removed and added lines on their own side", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a", baseLine: 1, targetLine: 1 },
      { kind: "removed", text: "b", baseLine: 2 },
      { kind: "added", text: "x", targetLine: 2 },
      { kind: "same", text: "c", baseLine: 3, targetLine: 3 },
    ]);
  });
});

describe("itemSummary", () => {
  it("lists added, removed and changed item IDs", () => {
    const base = "## S1 Build\nold detail\n## S2 Test\n- C1 keep\n- C2 drop";
    const target = "## S1 Build\nnew detail\n## S2 Test\n- C1 keep\n- C3 new\n\n";
    expect(itemSummary(base, target)).toEqual({ added: ["C3"], removed: ["C2"], changed: ["S1"] });
  });
});
