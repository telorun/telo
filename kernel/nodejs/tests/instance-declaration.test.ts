import { describe, expect, it } from "vitest";
import type { ResourceManifest } from "@telorun/sdk";
import {
  instanceDeclaration,
  recordInstanceDeclaration,
  recordOutermostDeclaration,
} from "../src/instance-declaration.js";
import { mintResourceHandle } from "../src/resource-handle.js";

const declared = (name: string): ResourceManifest =>
  ({ kind: "Lib.Source", metadata: { name } }) as ResourceManifest;

describe("the declaration a read past a live instance continues in", () => {
  it("is the outermost one recorded", () => {
    const instance = {};
    mintResourceHandle(instance, "Lib.Source", "source");
    const parent = declared("parent");
    const child = declared("child");
    recordInstanceDeclaration(instance, parent);
    recordOutermostDeclaration(instance, parent);
    recordInstanceDeclaration(instance, child);
    recordOutermostDeclaration(instance, child);
    expect(instanceDeclaration(instance)).toBe(child);
  });

  it("is refused as an invariant failure for an instance with none", () => {
    const instance = {};
    mintResourceHandle(instance, "Lib.Source", "orphan");
    expect(() => instanceDeclaration(instance)).toThrow(
      expect.objectContaining({ code: "ERR_FATAL", message: expect.stringContaining("Lib.Source/orphan") }),
    );
  });

  it("is none for a value that is no live instance", () => {
    expect(instanceDeclaration({ kind: "Lib.Source", name: "source" })).toBeUndefined();
  });
});
