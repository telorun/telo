import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";

const def = (d: Partial<ResourceDefinition> & { metadata: { name: string; module: string } }) =>
  d as unknown as ResourceDefinition;

describe("AnalysisRegistry.refFieldsForResource", () => {
  it("resolves a user-defined abstract's ref to its declared base capability", () => {
    const reg = new AnalysisRegistry();
    reg.registerModuleIdentity("std", "ai");
    // `Ai.Model` is an abstract that instances satisfy as `Telo.Invocable`.
    reg.registerDefinition(
      def({ kind: "Telo.Abstract", metadata: { name: "Model", module: "ai" }, capability: "Telo.Invocable" }),
    );
    reg.registerDefinition(
      def({
        kind: "Telo.Definition",
        metadata: { name: "Agent", module: "ai" },
        capability: "Telo.Invocable",
        schema: {
          type: "object",
          properties: {
            model: { "x-telo-ref": "std/ai#Model" },
            fallback: { "x-telo-ref": "telo#Runnable" },
          },
        },
      }),
    );

    const fields = reg.refFieldsForResource({
      kind: "ai.Agent",
      metadata: { name: "a" },
    } as unknown as ResourceManifest);

    const byPath = new Map(fields.map((f) => [f.path, f]));
    // The abstract ref resolves to the capability instances satisfy — not the
    // abstract kind "Ai.Model" — so the editor classifies it as a node port.
    expect(byPath.get("model")?.capabilities).toEqual(["Telo.Invocable"]);
    // Builtin abstracts still resolve: the kind itself is the capability.
    expect(byPath.get("fallback")?.capabilities).toEqual(["Telo.Runnable"]);
  });

  it("expands a capability group (Telo.Executable) to its leaf capabilities", () => {
    // Without expansion the editor's port classifier — which matches leaf
    // capabilities — would drop every `Telo.Executable` slot from the canvas.
    const reg = new AnalysisRegistry();
    reg.registerDefinition(
      def({
        kind: "Telo.Definition",
        metadata: { name: "Wrapper", module: "test" },
        capability: "Telo.Invocable",
        schema: {
          type: "object",
          properties: {
            body: { "x-telo-ref": { kind: "Telo.Executable", use: "call" } },
          },
        },
      }),
    );
    const fields = reg.refFieldsForResource({
      kind: "test.Wrapper",
      metadata: { name: "w" },
    } as unknown as ResourceManifest);
    expect(fields[0]?.capabilities?.slice().sort()).toEqual(["Telo.Invocable", "Telo.Runnable"]);
  });
});

describe("AnalysisRegistry.inputTypeForKind", () => {
  it("resolves an inline inputType to its schema", () => {
    const reg = new AnalysisRegistry();
    reg.registerDefinition(
      def({
        kind: "Telo.Definition",
        metadata: { name: "Echo", module: "echo" },
        capability: "Telo.Invocable",
        inputType: {
          kind: "Type.JsonSchema",
          schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      }),
    );
    expect(reg.inputTypeForKind("echo.Echo")).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("falls back to the extends-declared abstract's inputType", () => {
    const reg = new AnalysisRegistry();
    reg.registerDefinition(
      def({
        kind: "Telo.Abstract",
        metadata: { name: "Model", module: "ai" },
        capability: "Telo.Invocable",
        inputType: { type: "object", properties: { messages: { type: "array" } } },
      }),
    );
    reg.registerDefinition(
      def({
        kind: "Telo.Definition",
        metadata: { name: "OpenAi", module: "ai-openai" },
        capability: "Telo.Invocable",
        // Concrete model inherits its input contract from the abstract.
        extends: "ai.Model",
      }),
    );
    expect(reg.inputTypeForKind("ai-openai.OpenAi")).toEqual({
      type: "object",
      properties: { messages: { type: "array" } },
    });
  });

  it("returns undefined when no input contract is declared", () => {
    const reg = new AnalysisRegistry();
    reg.registerDefinition(
      def({ kind: "Telo.Definition", metadata: { name: "Bare", module: "m" }, capability: "Telo.Invocable" }),
    );
    expect(reg.inputTypeForKind("m.Bare")).toBeUndefined();
  });
});
