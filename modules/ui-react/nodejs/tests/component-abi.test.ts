import { describe, expect, it } from "vitest";
import { withUnhostedComponentsReplaced } from "../src/component-abi.js";
import layouts from "../src/contract/layouts.json" with { type: "json" };
import { call, component, listingNode } from "./spec-nodes.js";

describe("a listing's components", () => {
  it("are replaced where this renderer cannot host them: a layout's table cells, its compact layout's and the empty node", () => {
    const foreign = { ...component("StatusPill"), abi: "ui_react-0" };
    const table = { type: "table", columns: [{ header: "State", cell: foreign, labels: [] }], reads: {} };
    const hosted = withUnhostedComponentsReplaced(listingNode({ layout: table, compact: table, empty: foreign }), { abis: ["ui_react-1"], layoutAbis: [layouts.generation], specifiers: ["react"] }, () => {});
    const codes = [hosted.layout.columns[0].cell, hosted.compact.columns[0].cell, hosted.empty].map((node) => node.code);
    expect(codes).toEqual(["ERR_UI_COMPONENT_ABI_UNSUPPORTED", "ERR_UI_COMPONENT_ABI_UNSUPPORTED", "ERR_UI_COMPONENT_ABI_UNSUPPORTED"]);
  });

  it("replace a listing whose layout component is built for another contract than the hosted generation alone, naming it, and keep one that is not", () => {
    const hosted = { abis: ["ui_react-1"], layoutAbis: [layouts.generation], specifiers: ["react"] };
    const strip = (abi: string) => ({ ...component("RecordStrip"), abi, reads: {} });
    const reported: string[] = [];
    const refused = ["ui_react-1", "ui_react_layouts-1"].map((abi) => withUnhostedComponentsReplaced(listingNode({ layout: strip(abi) }), hosted, (error) => reported.push(error.code)));
    const kept = withUnhostedComponentsReplaced(listingNode({ compact: strip("ui_react_layouts-2") }), hosted, (error) => reported.push(error.code));
    expect(refused.map((node) => [node.type, node.code])).toEqual([
      ["error", "ERR_UI_COMPONENT_ABI_UNSUPPORTED"],
      ["error", "ERR_UI_COMPONENT_ABI_UNSUPPORTED"],
    ]);
    expect(refused[1].message).toBe("The component 'RecordStrip' is built for ABI 'ui_react_layouts-1'; this application hosts 'ui_react_layouts-2' for a listing layout.");
    expect([kept.type, kept.compact.abi]).toEqual(["listing", "ui_react_layouts-2"]);
    expect(reported).toEqual(["ERR_UI_COMPONENT_ABI_UNSUPPORTED", "ERR_UI_COMPONENT_ABI_UNSUPPORTED"]);
  });
});

describe("a call's components", () => {
  const foreign = { ...component("StatusPill"), abi: "ui_react-0" };
  const answering = call("/api/decisions", "Approve", { type: "object", properties: {} }, { result: foreign, failure: foreign });
  const hosted = { abis: ["ui_react-1"], layoutAbis: [layouts.generation], specifiers: ["react"] };
  const codes = (nodes: { code: string }[]) => nodes.map((node) => node.code);
  const replaced = "ERR_UI_COMPONENT_ABI_UNSUPPORTED";

  it("are replaced in the answer and failure trees of a button, a markdown node's annotations and a list's row actions", () => {
    const button = withUnhostedComponentsReplaced({ type: "button", action: answering, button: { type: "text" } }, hosted, () => {});
    const markdown = withUnhostedComponentsReplaced({ type: "markdown", value: { value: "" }, annotations: { rows: { value: [] }, line: { value: 1 }, action: answering } }, hosted, () => {});
    const list = withUnhostedComponentsReplaced({ type: "list", rows: { value: [] }, columns: [], rowActions: [answering] }, hosted, () => {});
    expect(codes([button.action.result, button.action.failure, markdown.annotations.action.result, list.rowActions[0].result])).toEqual([replaced, replaced, replaced, replaced]);
  });

  it("are replaced in the failure tree of a layout's move, which draws no result", () => {
    const move = call("/api/moves", null, { type: "object", properties: {} }, { failure: foreign });
    const kept = withUnhostedComponentsReplaced(listingNode({ layout: { type: "board", content: { type: "text", text: "x" }, move, reads: {} } }), { ...hosted, layoutAbis: [layouts.generation] }, () => {});
    expect([kept.layout.move.failure.code, "result" in kept.layout.move]).toEqual([replaced, false]);
  });
});
