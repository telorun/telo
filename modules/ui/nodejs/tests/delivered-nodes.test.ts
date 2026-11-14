import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { judgedComposite, producedNode, RequestNodes, type EvaluatedNode } from "../src/delivered-nodes.js";

/** Refuses a `link` with no `href`, a menu holding one, and an item that
 *  still carries `when`; records everything it was asked about. */
function validator() {
  const judged: unknown[] = [];
  return {
    judged,
    validate(node: { type: string; href?: unknown; items?: { href?: unknown; when?: unknown }[] }) {
      judged.push(node);
      if (node.type === "link" && typeof node.href !== "string") throw new Error("must have an href");
      if (node.items?.some((item) => typeof item.href !== "string")) throw new Error("an item must have an href");
      if (node.items?.some((item) => "when" in item)) throw new Error("an item takes no when");
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
    const provided = judgedComposite({ type: "table", columns: [], fill: false }, check, () => {});
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
      fill: false,
    });
    expect(refused).toEqual([["composite", "style must be one of the allowed values"]]);
    expect(judged.filter((node) => node.type === "table")).toHaveLength(1);
  });

  it("place a composite under its placement's condition — around it when the composite has one of its own", () => {
    const condition = (root: string) => ({ at: { root, path: ["flag"] }, matches: { const: true } });
    const composites = [{ type: "text", text: "plain", fill: false }, { type: "text", text: "gated", shown: condition("data"), fill: false }];
    const produced = (ref: number) =>
      producedNode({ type: "composite", ref, shown: condition("query") }, (index) => composites[index as number], validator(), () => {});
    expect(produced(0)).toEqual({ type: "text", text: "plain", shown: condition("query"), fill: false });
    expect(produced(1)).toEqual({ type: "box", children: [composites[1]], shown: condition("query"), fill: false });
  });

  it("keep a menu's items delivered for this request, leave out a menu with none, and replace one holding an item not valid", () => {
    const link = (text: string, when?: boolean, href: string | null = "/x") => ({ type: "link", text, href, ...(when === undefined ? {} : { when }) });
    const produce = (items: Record<string, unknown>[]) =>
      producedNode({ type: "menu", text: "Theme", items, when: true }, () => undefined, validator(), () => {});
    expect(produce([link("Default", true), link("Brand", false), link("Radix")])).toEqual({
      type: "menu",
      text: "Theme",
      items: [{ ...link("Default"), button: null }, { ...link("Radix"), button: null }],
    });
    expect(produce([link("Brand", false)])).toBeUndefined();
    expect(produce([link("Default"), link("Nowhere", true, null)])).toEqual(
      expect.objectContaining({ type: "error", code: "ERR_UI_NODE_INVALID" }),
    );
  });

  it("keep a tabs node's tabs delivered for this request, each tab's children produced, and leave out one with none", () => {
    const check = validator();
    const composite = { type: "table", columns: [] };
    const produce = (tabs: Record<string, unknown>[]) =>
      producedNode({ type: "tabs", tabs, address: { name: "section" } }, () => composite, check, () => {});
    const produced = produce([
      { text: "One", children: [{ type: "text", text: "a", when: false }, { type: "composite", ref: 0 }], when: true },
      { text: "Two", children: [], when: false },
      { text: "Three", children: [{ type: "link", text: "no address" }] },
    ]);
    expect(produced).toEqual({
      type: "tabs",
      tabs: [
        { key: "one", text: "One", children: [composite] },
        { key: "three", text: "Three", children: [expect.objectContaining({ type: "error", code: "ERR_UI_NODE_INVALID" })] },
      ],
      address: { name: "section" },
    });
    expect(check.judged.some((node) => JSON.stringify(node).includes("when"))).toBe(false);
    expect(produce([{ text: "Two", children: [], when: false }])).toBeUndefined();
  });

  it("invoke each pane they deliver with the request, and none a node switched off holds, and read every header", async () => {
    const asked: unknown[] = [];
    const pane = (text: string) => ({
      invoke: async (inputs: unknown) => {
        asked.push([text, inputs]);
        return { node: { type: "text", text, fill: false } };
      },
      snapshot: () => ({ assets: [{ digest: "d", name: `${text}.svg`, file: `/${text}.svg`, mediaType: "image/svg+xml" }] }),
    });
    const ctx = {
      resolveRef: (value: unknown) => value,
      createTypeValidator: () => ({ validate() {}, isValid: () => true }),
      // Stands for evaluating each `when` over the request.
      expandValue: (value: unknown) => JSON.parse(JSON.stringify(value).replace(/"when":"off"/g, '"when":false')),
      lookupSchema: () => undefined,
    } as unknown as ResourceContext;
    const nodes = await RequestNodes.prepare(
      [{ type: "pane", ref: pane("bar") }, { type: "stack", when: "off", children: [{ type: "pane", ref: pane("hidden") }] }],
      {},
      ctx,
      "the page",
    );
    expect(nodes.headerReads).toBe("*");
    expect(nodes.assets.map((asset) => asset.name)).toEqual(["bar.svg", "hidden.svg"]);
    const request = { headers: { "x-role": "admin" } };
    expect(await nodes.deliver(request)).toEqual([{ type: "text", text: "bar", fill: false }]);
    expect(asked).toEqual([["bar", { request }]]);
  });
});
