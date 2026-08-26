import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { inlineResourceKind } from "./ref-candidates";

describe("inlineResourceKind", () => {
  it("recognizes a resource declared inline at a ref slot", () => {
    expect(
      inlineResourceKind({
        kind: "Crud.Resource",
        plural: "todos",
        model: { kind: "Telo.JsonSchema", schema: { type: "object" } },
      }),
    ).toBe("Crud.Resource");
  });

  it("is not a reference — the loader's `{kind, name}` shape has a name", () => {
    expect(inlineResourceKind({ kind: "Crud.Resource", name: "todos" })).toBeNull();
  });

  it("is not a `!ref` sentinel", () => {
    expect(inlineResourceKind(makeTaggedSentinel("ref", "db"))).toBeNull();
  });

  it("is nothing for an unset slot or a plain value", () => {
    expect(inlineResourceKind(undefined)).toBeNull();
    expect(inlineResourceKind("db")).toBeNull();
    expect(inlineResourceKind({ path: "/api" })).toBeNull();
    expect(inlineResourceKind({ kind: "" })).toBeNull();
  });
});
