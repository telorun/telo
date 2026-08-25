import { describe, expect, it } from "vitest";
import {
  hasDeclaredUse,
  isRefSlot,
  possibleUses,
  readRefSlot,
  refSlotAnnotation,
  rewriteRefSlotKinds,
  transfersControl,
} from "../src/ref-slot.js";
import { buildReferenceFieldMap } from "../src/reference-field-map.js";

describe("readRefSlot — accepted shapes", () => {
  it("reads the bare string form with no declared use", () => {
    const slot = readRefSlot({ "x-telo-ref": "sql.Connection" })!;
    expect(slot.kinds).toEqual(["sql.Connection"]);
    expect(slot.uses).toEqual([]);
    expect(hasDeclaredUse(slot)).toBe(false);
  });

  it("unions kinds across anyOf branches", () => {
    const slot = readRefSlot({
      anyOf: [{ "x-telo-ref": "telo.Invocable" }, { "x-telo-ref": "telo.Runnable" }],
    })!;
    expect(slot.kinds).toEqual(["telo.Invocable", "telo.Runnable"]);
  });

  it("reads the structured form with a single kind", () => {
    const slot = readRefSlot({ "x-telo-ref": { kind: "sql.Connection", use: "dependency" } })!;
    expect(slot.kinds).toEqual(["sql.Connection"]);
    expect(slot.uses).toEqual(["dependency"]);
    expect(hasDeclaredUse(slot)).toBe(true);
  });

  it("reads a kind list — the anyOf replacement", () => {
    const slot = readRefSlot({
      "x-telo-ref": { kind: ["telo.Runnable", "telo.Service"], use: "call" },
    })!;
    expect(slot.kinds).toEqual(["telo.Runnable", "telo.Service"]);
    expect(slot.uses).toEqual(["call"]);
  });

  it("reads a use SET — one slot dispatching two ways (Cache.View)", () => {
    const slot = readRefSlot({
      "x-telo-ref": { kind: "telo.Invocable", use: ["call", "detached"] },
    })!;
    expect(slot.uses).toEqual(["call", "detached"]);
    expect(possibleUses(slot)).toEqual(["call", "detached"]);
  });

  it("reads a case map — mode selected by a sibling field (Lease.Critical)", () => {
    const slot = readRefSlot({
      "x-telo-ref": {
        kind: "telo.Executable",
        use: { by: "/detach", cases: { false: "call", true: "detached" } },
      },
    })!;
    expect(slot.uses).toEqual([]);
    expect(slot.useCases).toEqual({
      by: "/detach",
      cases: { false: ["call"], true: ["detached"] },
    });
    expect(hasDeclaredUse(slot)).toBe(true);
    expect(possibleUses(slot).sort()).toEqual(["call", "detached"]);
  });

  it("reads the argument-slot pointer", () => {
    const slot = readRefSlot({
      "x-telo-ref": { kind: "telo.Executable", use: "call", inputs: "/inputs" },
    })!;
    expect(slot.inputs).toBe("/inputs");
  });

  it("carries x-telo-inline from the slot or any branch", () => {
    expect(readRefSlot({ "x-telo-ref": "telo.Runnable", "x-telo-inline": true })!.inline).toBe(true);
    expect(
      readRefSlot({ anyOf: [{ "x-telo-ref": "telo.Runnable", "x-telo-inline": true }] })!.inline,
    ).toBe(true);
    expect(readRefSlot({ "x-telo-ref": "telo.Runnable" })!.inline).toBe(false);
  });

  it("returns undefined for a node declaring no slot", () => {
    expect(readRefSlot({ type: "string" })).toBeUndefined();
    expect(readRefSlot(undefined)).toBeUndefined();
    expect(isRefSlot({ type: "integer" })).toBe(false);
  });

  it("ignores an unrecognized use rather than inventing one", () => {
    const slot = readRefSlot({ "x-telo-ref": { kind: "telo.Runnable", use: "sideways" } })!;
    expect(slot.uses).toEqual([]);
  });
});

describe("transfersControl", () => {
  it("is false only for schema and dependency", () => {
    expect(transfersControl("schema")).toBe(false);
    expect(transfersControl("dependency")).toBe(false);
    expect(transfersControl("call")).toBe(true);
    expect(transfersControl("detached")).toBe(true);
    expect(transfersControl("trigger.inbound")).toBe(true);
    expect(transfersControl("trigger.consumer")).toBe(true);
  });
});

describe("rewriteRefSlotKinds", () => {
  it("rewrites the string form", () => {
    const node: Record<string, any> = { "x-telo-ref": "Self.Connection" };
    rewriteRefSlotKinds(node, () => "sql.Connection");
    expect(node["x-telo-ref"]).toBe("sql.Connection");
  });

  it("rewrites a structured single kind", () => {
    const node: Record<string, any> = { "x-telo-ref": { kind: "Self.Store", use: "dependency" } };
    rewriteRefSlotKinds(node, () => "cache.Store");
    expect(node["x-telo-ref"]).toEqual({ kind: "cache.Store", use: "dependency" });
  });

  it("rewrites each entry of a kind list, leaving unmapped names untouched", () => {
    const node: Record<string, any> = {
      "x-telo-ref": { kind: ["Self.A", "Other.B"], use: "call" },
    };
    rewriteRefSlotKinds(node, (k) => (k === "Self.A" ? "mod.A" : undefined));
    expect(node["x-telo-ref"].kind).toEqual(["mod.A", "Other.B"]);
  });
});

describe("refSlotAnnotation", () => {
  it("round-trips through readRefSlot", () => {
    const original = readRefSlot({
      "x-telo-ref": { kind: ["a.A", "b.B"], use: ["call", "detached"], inputs: "/inputs" },
    })!;
    const reread = readRefSlot({ "x-telo-ref": refSlotAnnotation(original) })!;
    expect(reread).toEqual(original);
  });

  it("round-trips a case map", () => {
    const original = readRefSlot({
      "x-telo-ref": { kind: "a.A", use: { by: "/detach", cases: { true: "detached" } } },
    })!;
    expect(readRefSlot({ "x-telo-ref": refSlotAnnotation(original) })!).toEqual(original);
  });
});

describe("buildReferenceFieldMap carries the slot's use", () => {
  it("records uses and the inputs pointer on the entry", () => {
    const map = buildReferenceFieldMap({
      properties: {
        store: { "x-telo-ref": { kind: "kv-store.Store", use: "dependency" } },
        invoke: {
          "x-telo-ref": { kind: "telo.Executable", use: "call", inputs: "/inputs" },
        },
        legacy: { "x-telo-ref": "telo.Invocable" },
      },
    });
    expect(map.get("store")).toMatchObject({ refs: ["kv-store.Store"], uses: ["dependency"] });
    expect(map.get("invoke")).toMatchObject({ uses: ["call"], inputs: "/inputs" });
    expect(map.get("legacy")).toMatchObject({ refs: ["telo.Invocable"], uses: [] });
  });
});

describe("value-or-reference union slots", () => {
  const columnType = {
    oneOf: [
      { title: "Storage class", type: "string", enum: ["text", "uuid", "bigint"] },
      { title: "Enum type", type: "object", "x-telo-ref": { kind: "Self.Enum", use: "schema" } },
    ],
  };

  it("collects the non-reference branches when the constraint is a branch", () => {
    const slot = readRefSlot(columnType)!;
    expect(slot.kinds).toEqual(["Self.Enum"]);
    expect(slot.valueBranches).toEqual([
      { title: "Storage class", type: "string", enum: ["text", "uuid", "bigint"] },
    ]);
  });

  it("collects none when the node carries the annotation itself", () => {
    // An Application `targets` entry: the branches describe the post-resolution
    // shapes a REFERENCE takes, so a bare string there is still the removed
    // string-reference spelling rather than a value.
    const slot = readRefSlot({
      "x-telo-ref": { kind: ["Telo.Runnable", "Telo.Service"], use: "call" },
      anyOf: [{ type: "string" }, { type: "object", required: ["kind", "name"] }],
    })!;
    expect(slot.valueBranches).toEqual([]);
  });

  it("carries the branches onto the field map entry", () => {
    const map = buildReferenceFieldMap({ properties: { columns: { additionalProperties: { properties: { type: columnType } } } } });
    expect(map.get("columns.{}.type")).toMatchObject({
      refs: ["Self.Enum"],
      valueBranches: [{ type: "string", title: "Storage class", enum: ["text", "uuid", "bigint"] }],
    });
  });
});
