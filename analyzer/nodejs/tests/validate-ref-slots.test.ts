import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { DefinitionRegistry } from "../src/definition-registry.js";
import {
  validateDynamicSelectors,
  validateRefSlotDeclarations,
} from "../src/validate-ref-slots.js";

function definitionWith(slotSchema: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Thing", module: "test" },
    capability: "Telo.Invocable",
    schema: { type: "object", properties: { slot: slotSchema } },
  } as unknown as ResourceManifest;
}

describe("validateRefSlotDeclarations", () => {
  it("accepts the legacy bare-string form without complaint", () => {
    expect(validateRefSlotDeclarations(definitionWith({ "x-telo-ref": "Self.Store" }))).toEqual(
      [],
    );
  });

  it("accepts a complete structured slot", () => {
    const issues = validateRefSlotDeclarations(
      definitionWith({
        "x-telo-ref": { kind: ["Telo.Invocable", "Telo.Runnable"], use: "call" },
      }),
    );
    expect(issues).toEqual([]);
  });

  it("flags an unrecognized use token — a typo must not degrade silently", () => {
    const issues = validateRefSlotDeclarations(
      definitionWith({ "x-telo-ref": { kind: "Self.Store", use: "cal" } }),
    );
    expect(issues.map((i) => i.code)).toEqual(["X_TELO_REF_INVALID_USE"]);
    expect(issues[0].message).toContain("'cal'");
  });

  it("flags a typo inside a case map's values", () => {
    const issues = validateRefSlotDeclarations(
      definitionWith({
        "x-telo-ref": {
          kind: "Self.Store",
          use: { by: "/detach", cases: { false: "call", true: "detahced" } },
        },
      }),
    );
    expect(issues.map((i) => i.code)).toEqual(["X_TELO_REF_INVALID_USE"]);
  });

  it("flags a structured form with no use", () => {
    const issues = validateRefSlotDeclarations(
      definitionWith({ "x-telo-ref": { kind: "Self.Store" } }),
    );
    expect(issues.map((i) => i.code)).toEqual(["X_TELO_REF_MISSING_USE"]);
  });

  it("flags a structured form with no kind", () => {
    const issues = validateRefSlotDeclarations(
      definitionWith({ "x-telo-ref": { use: "call" } }),
    );
    expect(issues.map((i) => i.code)).toEqual(["X_TELO_REF_MISSING_KIND"]);
  });

  it("flags anyOf branches whose declared uses disagree", () => {
    const issues = validateRefSlotDeclarations(
      definitionWith({
        anyOf: [
          { "x-telo-ref": { kind: "Telo.Invocable", use: "call" } },
          { "x-telo-ref": { kind: "Telo.Runnable", use: "trigger.inbound" } },
        ],
      }),
    );
    expect(issues.map((i) => i.code)).toEqual(["X_TELO_REF_USE_CONFLICT"]);
  });

  it("does not flag agreeing branches", () => {
    const issues = validateRefSlotDeclarations(
      definitionWith({
        anyOf: [
          { "x-telo-ref": { kind: "Telo.Invocable", use: "call" } },
          { "x-telo-ref": { kind: "Telo.Runnable", use: "call" } },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it("survives a cyclic $defs schema", () => {
    const definition = {
      kind: "Telo.Definition",
      metadata: { name: "Cyclic", module: "test" },
      capability: "Telo.Runnable",
      schema: {
        type: "object",
        $defs: {
          step: {
            type: "object",
            properties: {
              invoke: { "x-telo-ref": { kind: "Telo.Invocable" } }, // missing use
              then: { type: "array", items: { $ref: "#/$defs/step" } },
            },
          },
        },
        properties: { steps: { type: "array", items: { $ref: "#/$defs/step" } } },
      },
    } as unknown as ResourceManifest;
    const issues = validateRefSlotDeclarations(definition);
    expect(issues.map((i) => i.code)).toEqual(["X_TELO_REF_MISSING_USE"]);
  });
});

describe("validateDynamicSelectors", () => {
  const criticalDef = {
    kind: "Telo.Definition",
    metadata: { name: "Critical", module: "lease" },
    capability: "Telo.Invocable",
    schema: {
      type: "object",
      properties: {
        detach: { type: "boolean", default: false },
        invoke: {
          "x-telo-ref": {
            kind: "telo.Executable",
            use: { by: "/detach", cases: { false: "call", true: "detached" } },
          },
        },
      },
    },
  };
  const echoDef = {
    kind: "Telo.Definition",
    metadata: { name: "Echo", module: "test" },
    capability: "Telo.Invocable",
    schema: { type: "object", properties: {} },
  };
  const registry = new DefinitionRegistry();
  registry.register(criticalDef as never);
  registry.register(echoDef as never);
  const ref = (name: string) => makeTaggedSentinel("ref", name);

  it("reports a CEL-valued selector, and only that", () => {
    const resources = [
      { kind: "test.Echo", metadata: { name: "Body" } },
      {
        kind: "lease.Critical",
        metadata: { name: "Dynamic", module: "app" },
        detach: makeTaggedSentinel("cel", "variables.detach"),
        invoke: ref("Body"),
      },
      // Omitted selector: resolved from the schema default, no issue.
      { kind: "lease.Critical", metadata: { name: "Defaulted", module: "app" }, invoke: ref("Body") },
      // Literal selector: resolved, no issue.
      {
        kind: "lease.Critical",
        metadata: { name: "Literal", module: "app" },
        detach: true,
        invoke: ref("Body"),
      },
    ] as unknown as ResourceManifest[];
    const issues = validateDynamicSelectors(resources, registry);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("X_TELO_REF_DYNAMIC_SELECTOR");
    expect(issues[0].manifest.metadata?.name).toBe("Dynamic");
    // Anchored at the SELECTOR field the author must change, not the ref slot.
    expect(issues[0].path).toBe("detach");
  });
});
