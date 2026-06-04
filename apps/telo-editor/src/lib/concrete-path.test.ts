import { describe, expect, it } from "vitest";
import {
  concretePathToPointer,
  leafConcreteIndex,
  parseConcretePath,
  readConcretePath,
  writeConcretePath,
} from "./concrete-path";

describe("parseConcretePath", () => {
  it("splits dotted segments and trailing array indices", () => {
    expect(parseConcretePath("routes[2].handler")).toEqual([{ key: "routes", index: 2 }, { key: "handler" }]);
    expect(parseConcretePath("encoder")).toEqual([{ key: "encoder" }]);
  });
});

describe("concretePathToPointer", () => {
  it("converts to JSON pointer segments", () => {
    expect(concretePathToPointer("routes[2].handler")).toBe("/routes/2/handler");
    expect(concretePathToPointer("targets[0]")).toBe("/targets/0");
    expect(concretePathToPointer("notFoundHandler")).toBe("/notFoundHandler");
  });
});

describe("readConcretePath", () => {
  it("reads through objects and array indices", () => {
    const data = { routes: [{ handler: "h0" }, { handler: "h1" }], encoder: "e" };
    expect(readConcretePath(data, "routes[1].handler")).toBe("h1");
    expect(readConcretePath(data, "encoder")).toBe("e");
    expect(readConcretePath(data, "routes[9].handler")).toBeUndefined();
  });
});

describe("leafConcreteIndex", () => {
  it("returns the trailing array index, or -1", () => {
    expect(leafConcreteIndex("targets[3]")).toBe(3);
    expect(leafConcreteIndex("routes[2].handler")).toBe(-1);
    expect(leafConcreteIndex("encoder")).toBe(-1);
  });
});

describe("writeConcretePath", () => {
  it("sets a single key and appends an array slot, creating containers", () => {
    const fields: Record<string, unknown> = {};
    writeConcretePath(fields, "encoder", "E");
    writeConcretePath(fields, "targets[0]", "A");
    writeConcretePath(fields, "targets[1]", "B");
    expect(fields).toEqual({ encoder: "E", targets: ["A", "B"] });
  });

  it("clears a key and splices an array index when value is null", () => {
    const fields: Record<string, unknown> = { encoder: "E", targets: ["A", "B", "C"] };
    writeConcretePath(fields, "encoder", null);
    writeConcretePath(fields, "targets[1]", null);
    expect(fields).toEqual({ targets: ["A", "C"] });
  });

  it("clears a sub-field but leaves its container object", () => {
    const fields: Record<string, unknown> = { mounts: [{ path: "/x", type: "T" }] };
    writeConcretePath(fields, "mounts[0].type", null);
    expect(fields).toEqual({ mounts: [{ path: "/x" }] });
  });
});
