import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

describe("a kind whose x-telo-scope openedBy is malformed or misplaced", () => {
  const register = (capability: string, scope: Record<string, unknown>) =>
    new Kernel({ sources: [new LocalFileSource()], env: {} }).registerResourceDefinition({
      kind: "Telo.Definition",
      metadata: { name: "Holder", module: "Ui" },
      capability,
      schema: {
        type: "object",
        properties: { members: { type: "array", "x-telo-scope": scope, items: { type: "object" } } },
      },
    } as any);

  const refused = expect.objectContaining({
    code: "ERR_SCOPE_OPENED_BY_INVALID",
    message: expect.stringContaining("'Holder' declares `x-telo-scope` at 'schema.properties.members.x-telo-scope'"),
  });

  it("is refused when it names an unknown mode", () => {
    expect(() => register("Telo.Runnable", { regions: ["/steps"], openedBy: "call" })).toThrow(refused);
  });

  it("is refused on a kind nothing dispatches", () => {
    expect(() => register("Telo.Provider", { regions: ["/steps"], openedBy: "dispatch" })).toThrow(refused);
  });
});
