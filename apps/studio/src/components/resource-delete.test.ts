import { describe, expect, it } from "vitest";
import { canDeleteResourceByKey, canDeleteSelection } from "./resource-delete";

describe("canDeleteSelection", () => {
  it("allows a whole ordinary resource", () => {
    expect(canDeleteSelection({ kind: "Console.WriteLine" }, "")).toBe(true);
  });
  it("refuses a place inside a resource", () => {
    expect(canDeleteSelection({ kind: "Console.WriteLine" }, "/inputs")).toBe(false);
  });
  it("refuses the module root, whole or not", () => {
    expect(canDeleteSelection({ kind: "Telo.Application" }, "")).toBe(false);
    expect(canDeleteSelection({ kind: "Telo.Library" }, "/targets/0/inputs")).toBe(false);
  });
});

describe("canDeleteResourceByKey", () => {
  const resource = { kind: "Console.WriteLine", name: "hello" };
  const inside = (pointer: string) => ({ resource, pointer });

  it("allows a whole-resource selection", () => {
    expect(canDeleteResourceByKey(resource, inside(""))).toBe(true);
    expect(canDeleteResourceByKey(resource, null)).toBe(true);
  });
  it("refuses while a field of the resource is selected", () => {
    expect(canDeleteResourceByKey(resource, inside("/field"))).toBe(false);
  });
  it("ignores a pointer selected inside another resource", () => {
    const other = { resource: { kind: "Console.WriteLine", name: "other" }, pointer: "/field" };
    expect(canDeleteResourceByKey(resource, other)).toBe(true);
  });
});
