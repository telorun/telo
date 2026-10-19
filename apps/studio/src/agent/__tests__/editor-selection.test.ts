import { describe, expect, it } from "vitest";

import { selectionBlock, selectionLabel, splitUserText, withSelections, type EditorSelection } from "../editor-selection";

const selection: EditorSelection = {
  file: "apps/todo/telo.yaml",
  startLine: 12,
  endLine: 13,
  text: "kind: Http.Server\nport: 80\n",
};

describe("a selection carried in a message", () => {
  it("is labelled by its file and lines", () => {
    expect(selectionLabel(selection)).toBe("apps/todo/telo.yaml:12-13");
    expect(selectionLabel({ ...selection, endLine: 12 })).toBe("apps/todo/telo.yaml:12");
  });

  it("is a block after what was typed, fenced past any fence inside it", () => {
    expect(withSelections("why does this fail?", [selection])).toBe(
      "why does this fail?\n\n```telo-selection apps/todo/telo.yaml:12-13\nkind: Http.Server\nport: 80\n```",
    );
    expect(selectionBlock({ file: "README.md", startLine: 7, endLine: 7, text: "```sh" })).toBe(
      "````telo-selection README.md:7\n```sh\n````",
    );
  });

  it("is read back apart from what was typed", () => {
    const sent = withSelections("why does this fail?", [selection, { ...selection, file: "a b.md", startLine: 2, endLine: 2, text: "```sh" }]);
    expect(splitUserText(sent)).toEqual({
      prose: "why does this fail?",
      selections: [
        { file: "apps/todo/telo.yaml", startLine: 12, endLine: 13, text: "kind: Http.Server\nport: 80" },
        { file: "a b.md", startLine: 2, endLine: 2, text: "```sh" },
      ],
    });
  });

  it("is left in the text when its fence never closes, or is not at a line's start", () => {
    const open = "look\n\n```telo-selection telo.yaml:1\nkind: X";
    expect(splitUserText(open)).toEqual({ prose: open, selections: [] });
    const quoted = "look\n  ```telo-selection telo.yaml:1\nkind: X\n```";
    expect(splitUserText(quoted)).toEqual({ prose: quoted, selections: [] });
  });

  it("leaves a message without one as it is", () => {
    expect(splitUserText("build it\n\n```yaml\nkind: X\n```")).toEqual({
      prose: "build it\n\n```yaml\nkind: X\n```",
      selections: [],
    });
  });
});
