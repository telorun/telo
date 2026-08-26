import { parseToAst } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import type { ModuleSourceFile } from "../model";
import { locateSlice, rangeInSlice, spliceSlice } from "./detail-yaml-slice";

const TEXT = `kind: Run.Sequence
metadata:
  name: main # the entry point
steps:
  - name: fetch
    # keeps its comment
    invoke: !ref client
    inputs:
      url: https://example.com
  - name: log
    invoke: !ref console
---
kind: JS.Script
metadata:
  name: transform
code: |
  return 1
`;

function files(text = TEXT): ModuleSourceFile[] {
  return [{ filePath: "/t.yaml", text, documents: parseToAst(text) }];
}

function sliceText(pointer: string, kind = "Run.Sequence", name = "main"): string | undefined {
  return locateSlice(files(), kind, name, pointer)?.slice.text;
}

describe("locateSlice", () => {
  it("slices the whole resource document for an empty pointer", () => {
    const text = sliceText("");
    expect(text).toContain("kind: Run.Sequence");
    expect(text).toContain("invoke: !ref console");
    // The second document is a different resource and is not in the span.
    expect(text).not.toContain("JS.Script");
  });

  it("picks the document by kind and name, not by position", () => {
    expect(sliceText("", "JS.Script", "transform")).toContain("name: transform");
  });

  it("slices one step, dedented to column zero", () => {
    expect(sliceText("/steps/0")).toBe(
      ["name: fetch", "# keeps its comment", "invoke: !ref client", "inputs:", "  url: https://example.com"].join("\n"),
    );
  });

  it("keeps comments and tags exactly as written", () => {
    expect(sliceText("/metadata")).toBe("name: main # the entry point");
  });

  it("slices a nested pointer", () => {
    expect(sliceText("/steps/0/inputs")).toBe("url: https://example.com");
  });

  it("slices a block scalar without breaking its body", () => {
    // The `|` header sits at the node's start and its body is indented BELOW
    // that column, so dedenting by the start column would corrupt it. The
    // common indent of the continuation lines is what makes this work.
    expect(sliceText("/code", "JS.Script", "transform")).toBe("|\nreturn 1");
  });

  it("returns nothing for a path the source does not write", () => {
    expect(locateSlice(files(), "Run.Sequence", "main", "/steps/1/inputs")).toBeUndefined();
  });

  it("returns nothing for an unknown resource", () => {
    expect(locateSlice(files(), "Run.Sequence", "absent", "")).toBeUndefined();
  });

  it("skips a file that failed to parse", () => {
    const broken: ModuleSourceFile[] = [
      { filePath: "/b.yaml", text: TEXT, documents: parseToAst(TEXT), parseError: "boom" },
    ];
    expect(locateSlice(broken, "Run.Sequence", "main", "")).toBeUndefined();
  });
});

describe("rangeInSlice", () => {
  // In TEXT, `invoke: !ref client` is line 6 (0-indexed) at column 4, and the
  // step slice at /steps/0 starts on line 4 at column 4 with a 4-space indent
  // stripped from its continuation lines.
  const stepSlice = () => locateSlice(files(), "Run.Sequence", "main", "/steps/0")!;

  it("shifts a continuation line by the stripped indent", () => {
    const located = stepSlice();
    const range = rangeInSlice(located.fileText, located.slice, {
      start: { line: 6, character: 4 },
      end: { line: 6, character: 10 },
    });
    expect(range).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 2, character: 6 },
    });
  });

  it("shifts the first line by the slice's own start column instead", () => {
    // The first line's leading whitespace lies BEFORE the span, so it is not
    // part of what was stripped.
    const located = stepSlice();
    const range = rangeInSlice(located.fileText, located.slice, {
      start: { line: 4, character: 4 },
      end: { line: 4, character: 8 },
    });
    expect(range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 4 },
    });
  });

  it("drops a range outside the slice rather than clamping it", () => {
    // Underlining a line the diagnostic says nothing about is worse than
    // showing nothing.
    const located = stepSlice();
    const above = rangeInSlice(located.fileText, located.slice, {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 8 },
    });
    const below = rangeInSlice(located.fileText, located.slice, {
      start: { line: 17, character: 0 },
      end: { line: 17, character: 4 },
    });
    expect(above).toBeNull();
    expect(below).toBeNull();
  });

  it("maps a whole-document range one-to-one", () => {
    const located = locateSlice(files(), "Run.Sequence", "main", "")!;
    expect(
      rangeInSlice(located.fileText, located.slice, {
        start: { line: 2, character: 2 },
        end: { line: 2, character: 6 },
      }),
    ).toEqual({ start: { line: 2, character: 2 }, end: { line: 2, character: 6 } });
  });
});

describe("spliceSlice", () => {
  it("round-trips an untouched slice byte for byte", () => {
    const located = locateSlice(files(), "Run.Sequence", "main", "/steps/0")!;
    expect(spliceSlice(located.fileText, located.slice, located.slice.text)).toBe(TEXT);
  });

  it("re-indents an edit to the node's own depth", () => {
    const located = locateSlice(files(), "Run.Sequence", "main", "/steps/0/inputs")!;
    const next = spliceSlice(
      located.fileText,
      located.slice,
      "url: https://example.org\nmethod: POST",
    );
    expect(next).toContain("      url: https://example.org\n      method: POST\n");
    // Everything outside the span is untouched — the second document included.
    expect(next).toContain("# keeps its comment");
    expect(next).toContain("kind: JS.Script");
  });

  it("leaves a blank line blank rather than indenting it", () => {
    const located = locateSlice(files(), "Run.Sequence", "main", "/steps/0/inputs")!;
    const next = spliceSlice(located.fileText, located.slice, "url: x\n\nmethod: POST");
    expect(next).toContain("      url: x\n\n      method: POST");
  });

  it("writes a whole-document edit at column zero", () => {
    const located = locateSlice(files(), "JS.Script", "transform", "")!;
    const next = spliceSlice(located.fileText, located.slice, "kind: JS.Script\nmetadata:\n  name: renamed");
    expect(next).toContain("kind: JS.Script\nmetadata:\n  name: renamed");
    expect(next).toContain("kind: Run.Sequence");
  });
});
