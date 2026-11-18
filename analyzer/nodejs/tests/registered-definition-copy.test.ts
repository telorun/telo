import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { frozenDocuments } from "./frozen-documents.js";

/** A registry whose entry module `app` imports `lib` as `Lib`. */
function registry(): AnalysisRegistry {
  const r = new AnalysisRegistry();
  r.registerUngatedAlias("Telo", "Telo");
  r.registerUngatedAlias("Self", "app");
  r.registerUngatedAlias("app", "app");
  r.registerImport("Lib", "lib", ["Store", "Keys", "Transaction", "Base"]);
  r.forModule("lib");
  return r;
}

const definition = (module: string, name: string, rest: Record<string, unknown>): ResourceDefinition =>
  frozenDocuments({ kind: "Telo.Definition", metadata: { name, module }, capability: "Telo.Invocable", ...rest }) as unknown as ResourceDefinition;

describe("the registration door", () => {
  it("registers a copy naming every annotation kind canonically, the written document as authored", () => {
    const written = definition("app", "Holder", {
      schema: {
        type: "object",
        "x-telo-text-keys": ["Lib.Keys"],
        "x-telo-referrer-rules": [{ referrer: "Self.Server", condition: "true", code: "A", message: "m" }],
        "x-telo-resource-rules": [
          { reachable: { kind: "Lib.Store", use: "dependency", through: ["dependency"] }, condition: "true", code: "B", message: "m" },
        ],
        properties: {
          store: {
            "x-telo-ref": { kind: "Lib.Store", use: "call", callsCoReferrers: { kind: "Self.Listener", slot: "/target" } },
          },
          body: { "x-telo-requires-zone": { zone: "Lib.Transaction" } },
        },
      },
    });
    const authored = structuredClone(written);
    const r = registry();
    r.registerDefinition(written);

    const schema = r.resolveDefinition("app.Holder")!.schema as Record<string, any>;
    expect(schema["x-telo-text-keys"]).toEqual(["lib.Keys"]);
    expect(schema["x-telo-referrer-rules"][0].referrer).toBe("app.Server");
    expect(schema["x-telo-resource-rules"][0].reachable.kind).toBe("lib.Store");
    expect(schema.properties.store["x-telo-ref"]).toEqual({
      kind: "lib.Store",
      use: "call",
      callsCoReferrers: { kind: "app.Listener", slot: "/target" },
    });
    expect(schema.properties.body["x-telo-requires-zone"]).toEqual({ zone: "lib.Transaction" });
    expect(written).toEqual(authored);
  });

  it("gives a merge-form child the kinds its parent's module named", () => {
    const r = registry();
    r.registerDefinition(
      definition("lib", "Base", {
        schema: { type: "object", properties: { store: { "x-telo-ref": { kind: "Self.Store", use: "dependency" } } } },
      }),
    );
    const child = definition("app", "Child", {
      extends: "Lib.Base",
      schema: { type: "object", properties: { own: { "x-telo-ref": { kind: "Self.Server", use: "dependency" } } } },
    });
    r.registerDefinition(child, "lib.Base");

    const properties = r.effectiveKind("app.Child")!.schema!.properties as Record<string, any>;
    expect(properties.store["x-telo-ref"].kind).toBe("lib.Store");
    expect(properties.own["x-telo-ref"].kind).toBe("app.Server");
    expect(child.extends).toBe("Lib.Base");
  });
});
