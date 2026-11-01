import { describe, expect, it } from "vitest";
import { withUnhostedComponentsReplaced } from "../src/component-abi.js";
import { component, listingNode } from "./spec-nodes.js";

describe("a listing's components", () => {
  it("are replaced where this renderer cannot host them: a layout's table cells, its compact layout's and the empty node", () => {
    const foreign = { ...component("StatusPill"), abi: "ui_react-0" };
    const table = { type: "table", columns: [{ header: "State", cell: foreign, labels: [] }], reads: {} };
    const hosted = withUnhostedComponentsReplaced(listingNode({ layout: table, compact: table, empty: foreign }), { abis: ["ui_react-1"], layoutAbis: ["ui_react_layouts-1"], specifiers: ["react"] }, () => {});
    const codes = [hosted.layout.columns[0].cell, hosted.compact.columns[0].cell, hosted.empty].map((node) => node.code);
    expect(codes).toEqual(["ERR_UI_COMPONENT_ABI_UNSUPPORTED", "ERR_UI_COMPONENT_ABI_UNSUPPORTED", "ERR_UI_COMPONENT_ABI_UNSUPPORTED"]);
  });

  it("replace a listing whose layout component is built for another contract than the layout one, and keep one that is not", () => {
    const hosted = { abis: ["ui_react-1"], layoutAbis: ["ui_react_layouts-1"], specifiers: ["react"] };
    const strip = (abi: string) => ({ ...component("RecordStrip"), abi, reads: {} });
    const reported: string[] = [];
    const refused = withUnhostedComponentsReplaced(listingNode({ layout: strip("ui_react-1") }), hosted, (error) => reported.push(error.code));
    const kept = withUnhostedComponentsReplaced(listingNode({ compact: strip("ui_react_layouts-1") }), hosted, (error) => reported.push(error.code));
    expect([refused.type, refused.code, kept.type, kept.compact.abi]).toEqual(["error", "ERR_UI_COMPONENT_ABI_UNSUPPORTED", "listing", "ui_react_layouts-1"]);
    expect(reported).toEqual(["ERR_UI_COMPONENT_ABI_UNSUPPORTED"]);
  });
});
