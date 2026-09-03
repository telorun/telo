import type { GraphNode, GraphPort } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import type { RefResolver } from "../../../resource-schema-form/ref-candidates";
import { isPickerPort, pickerRows, pickerCandidates } from "./picker-port";

const port = (over: Partial<GraphPort> = {}): GraphPort => ({
  slot: "connection",
  refs: ["Sql.Connection"],
  capabilities: ["Telo.Provider"],
  array: false,
  class: "holds",
  slots: [{ path: "connection" }],
  ...over,
});

const node = (name: string, over: Partial<GraphNode> = {}): GraphNode =>
  ({
    id: `k.K\u0000${name}`,
    kind: "sqlite.Connection",
    name,
    ownership: "named",
    ports: [],
    rows: [],
    rowArrays: [],
    ...over,
  }) as GraphNode;

const resolver = (accepted: Record<string, string[]>): RefResolver => ({
  acceptedKindsForRef: (ref) => (accepted[ref] ? new Set(accepted[ref]) : undefined),
  resolveKind: (kind) => kind,
});

describe("which slots are picked rather than wired", () => {
  it("picks a hold on ambient infrastructure", () => {
    expect(isPickerPort(port())).toBe(true);
    expect(isPickerPort(port({ capabilities: ["Telo.Type"] }))).toBe(true);
  });

  it("leaves a CALLED provider wired — Ai.Model draws a real edge", () => {
    expect(isPickerPort(port({ class: "flow" }))).toBe(false);
  });

  it("leaves a hold on a working resource wired", () => {
    expect(isPickerPort(port({ capabilities: ["Telo.Invocable"] }))).toBe(false);
  });

  it("leaves a slot that could hold either wired, so the edge keeps its socket", () => {
    expect(isPickerPort(port({ capabilities: ["Telo.Provider", "Telo.Invocable"] }))).toBe(false);
  });

  it("says nothing about a slot whose constraint resolved to no capability", () => {
    expect(isPickerPort(port({ capabilities: [] }))).toBe(false);
  });
});

describe("the rows a picker draws", () => {
  it("gives a single slot one select, which can be UNSET", () => {
    expect(pickerRows(port())).toEqual([{ path: "connection", role: "slot" }]);
  });

  it("gives an array one select per entry plus the next", () => {
    // An entry is an `item` and the trailing line is the `add`: they differ in
    // what may be done to them, so a renderer must not have to count indices to
    // tell which is which.
    expect(
      pickerRows(
        port({
          slot: "tables[]",
          array: true,
          slots: [{ path: "tables[0]", target: "users" }],
          addPath: "tables[1]",
        }),
      ),
    ).toEqual([
      { path: "tables[0]", target: "users", role: "item" },
      { path: "tables[1]", role: "add" },
    ]);
  });

  it("gives an EMPTY array just the line that appends to it", () => {
    expect(
      pickerRows(port({ slot: "enums[]", array: true, slots: [], addPath: "enums[0]" })),
    ).toEqual([{ path: "enums[0]", role: "add" }]);
  });

  it("keeps a line for a slot with no write site, so the branch is still named", () => {
    expect(pickerRows(port({ slot: "sources{}", slots: [] }))).toEqual([{ role: "slot" }]);
  });
});

describe("what a picker offers", () => {
  const nodes = [
    node("root", { root: true, ownership: "root", kind: "Telo.Application" }),
    node("chatDb"),
    node("otherDb"),
    node("inline", { ownership: "inline", owner: "x" }),
    node("handler", { kind: "js.Script" }),
  ];

  it("offers exactly what a drag onto it would be allowed to land on", () => {
    const options = pickerCandidates(
      port(),
      nodes,
      resolver({ "Sql.Connection": ["sqlite.Connection"] }),
    );
    expect(options).toEqual(["chatDb", "otherDb"]);
  });

  it("never offers an owned declaration — it has no name to reference it by", () => {
    const options = pickerCandidates(port(), nodes, resolver({ "Sql.Connection": [] }));
    expect(options).toEqual([]);
  });

  it("writes an imported instance alias-qualified, as a reference to it is written", () => {
    const options = pickerCandidates(
      port(),
      [node("db", { external: true, alias: "Store", module: "store" })],
      resolver({ "Sql.Connection": ["sqlite.Connection"] }),
    );
    expect(options).toEqual(["Store.db"]);
  });
});
