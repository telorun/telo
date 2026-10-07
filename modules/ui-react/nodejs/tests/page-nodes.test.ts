import { describe, expect, it } from "vitest";
import { judgedComposite, producedNode, type EvaluatedNode } from "../src/page-nodes.js";

/** Refuses a `link` with no `href`, and records everything it was asked about. */
function validator() {
  const judged: unknown[] = [];
  return {
    judged,
    validate(node: { type: string; href?: unknown }) {
      judged.push(node);
      if (node.type === "link" && typeof node.href !== "string") throw new Error("must have an href");
    },
    isValid: () => true,
  };
}

const sizeOf = (node: unknown): number => JSON.stringify(node).length;

describe("a page's nodes for a request", () => {
  it("are each judged once, a container with its children already judged", () => {
    const leaf = (text: string): EvaluatedNode => ({ type: "text", text });
    const page: EvaluatedNode = {
      type: "stack",
      children: [
        leaf("a"),
        { type: "box", children: [leaf("b"), { type: "box", children: [leaf("c"), { type: "link", text: "no address" }] }] },
        { type: "text", text: "hidden", when: false },
      ],
    };
    const check = validator();
    const refused: string[] = [];
    const produced = producedNode(page, () => undefined, check, (node) => refused.push(node.type));
    // Seven nodes are produced; each is handed over once, with nothing beneath
    // it but stand-ins for what was already judged.
    expect(check.judged).toHaveLength(7);
    expect(Math.max(...check.judged.map(sizeOf))).toBeLessThan(120);
    expect(refused).toEqual(["link"]);
    expect(produced).toEqual({
      type: "stack",
      children: [
        { type: "text", text: "a" },
        {
          type: "box",
          children: [
            { type: "text", text: "b" },
            { type: "box", children: [{ type: "text", text: "c" }, expect.objectContaining({ type: "error", code: "ERR_UI_NODE_INVALID" })] },
          ],
        },
      ],
    });
  });

  it("place what a composite provided without judging it again: that was done once, at start", () => {
    const check = validator();
    const provided = judgedComposite({ type: "table", columns: [] }, check, () => {});
    expect(check.judged).toHaveLength(1);
    const placing: EvaluatedNode = { type: "stack", children: [{ type: "composite", ref: 0 }, { type: "composite", ref: 0, style: "muted" }] };
    for (let request = 0; request < 3; request++) {
      expect(producedNode(placing, () => provided, check, () => {})).toEqual({
        type: "stack",
        children: [provided, { ...provided, style: "muted" }],
      });
    }
    // Per request: the stack, and the style one placement adds. Never the table.
    expect(check.judged).toHaveLength(1 + 3 * 2);
    expect(check.judged.slice(1).some((node) => (node as { type: string }).type === "table")).toBe(false);
  });

  it("replace a composite placed with a style outside the closed list, its own node still judged once", () => {
    const judged: Array<{ type: string }> = [];
    const check = {
      validate(node: { type: string; style?: unknown }) {
        judged.push(node);
        if ([node.style].flat().includes("neon")) throw new Error("style must be one of the allowed values");
      },
      isValid: () => true,
    };
    const provided = judgedComposite({ type: "table", columns: [], style: "muted" }, check, () => {});
    const refused: Array<[string, string]> = [];
    const produced = producedNode({ type: "composite", ref: 0, style: "neon" }, () => provided, check, (node, reason) =>
      refused.push([node.type, reason]),
    );
    expect(produced).toEqual({
      type: "error",
      code: "ERR_UI_NODE_INVALID",
      message: "A 'composite' node is not valid for this request: style must be one of the allowed values",
    });
    expect(refused).toEqual([["composite", "style must be one of the allowed values"]]);
    expect(judged.filter((node) => node.type === "table")).toHaveLength(1);
  });
});
