import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { inlineResourceKind } from "./ref-candidates";

describe("inlineResourceKind", () => {
  it("recognizes a resource declared inline at a ref slot", () => {
    expect(
      inlineResourceKind({
        kind: "Crud.Api",
        plural: "todos",
        model: { kind: "Telo.JsonSchema", schema: { type: "object" } },
      }),
    ).toBe("Crud.Api");
  });

  it("is a declaration of a kind whose configuration has a `name` field", () => {
    expect(inlineResourceKind({ kind: "UiLucide.Icon", name: "house" })).toBe("UiLucide.Icon");
  });

  it("is not a resolved reference — the loader's shape carries the marker", () => {
    expect(inlineResourceKind({ __ref: true, kind: "Crud.Api", name: "todos" })).toBeNull();
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
