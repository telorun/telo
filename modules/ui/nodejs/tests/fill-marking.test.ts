import { describe, expect, it } from "vitest";
import { producedNode, type EvaluatedNode } from "../src/delivered-nodes.js";
import { filledNode } from "../src/fill-marking.js";

const accepting = { validate() {}, isValid: () => true };

/** A page's nodes for a request, as `RequestNodes.deliver` produces them. */
const delivered = (nodes: EvaluatedNode[]) =>
  nodes.map((node) => producedNode(node, () => undefined, accepting, () => {})).filter((node) => node !== undefined).map(filledNode);

describe("filling", () => {
  it("marks every node between a filling node and the page, and none beside it", () => {
    const chat = { type: "chat", header: [{ type: "bar", start: [], center: [], end: [], fill: true }], fill: false };
    const split = {
      type: "split",
      aside: { actions: [{ type: "link", fill: false }], content: { type: "listing", fill: false } },
      content: { ...chat, fill: true },
      fill: false,
    };
    const [heading, placed] = delivered([{ type: "text", text: "Title", fill: false }, { type: "stack", children: [split], fill: false }]);
    expect(heading).toMatchObject({ fill: false });
    expect(placed).toMatchObject({
      type: "stack",
      fill: true,
      children: [
        {
          type: "split",
          fill: true,
          aside: { actions: [{ fill: false }], content: { fill: false } },
          // The header is a box of its own: what fills inside it fills the chat no further.
          content: { type: "chat", fill: true, header: [{ type: "bar", fill: true }] },
        },
      ],
    });
  });

  it("marks nothing for a filling node a condition leaves out", () => {
    const [stack] = delivered([{ type: "stack", children: [{ type: "text", text: "Gone", fill: true, when: false }, { type: "text", text: "Kept", fill: false }], fill: false }]);
    expect(stack).toEqual({ type: "stack", children: [{ type: "text", text: "Kept", fill: false }], fill: false });
  });
});
