import type { ResourceManifest } from "@telorun/sdk";
import { celEngine } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment, buildTypedCelEnvironment } from "../src/cel-environment.js";
import { celTypeSatisfiesJsonSchema } from "../src/schema-compat.js";

describe("time and unsigned value types in CEL", () => {
  const app = {
    kind: "Telo.Application",
    metadata: { name: "app" },
    variables: {
      opens: { env: "OPENS", type: "string", "x-telo-type": "Telo.Timestamp" },
      lasts: { env: "LASTS", type: "string", "x-telo-type": "Telo.Duration" },
      quota: { env: "QUOTA", type: "integer", "x-telo-type": "Telo.Uint64" },
    },
  } as unknown as ResourceManifest;
  const analyze = (expr: string) =>
    celEngine.analyze!(expr, {
      celEnv: buildTypedCelEnvironment(buildCelEnvironment(), app),
      contextSchema: null,
    });

  it("types a timestamp with duration arithmetic, and a uint with unsigned arithmetic", () => {
    expect(analyze("variables.opens + variables.lasts > now()")).toMatchObject({
      diagnostics: [],
      type: "bool",
    });
    expect(analyze("variables.opens + variables.lasts").type).toBe("google.protobuf.Timestamp");
    expect(analyze("variables.quota + 1u").type).toBe("uint");
  });

  it("keeps an instance's CEL type out of a JSON-typed slot, and text out of an instance slot", () => {
    const timestampSlot = { "x-telo-type": "Telo.Timestamp" };
    expect(celTypeSatisfiesJsonSchema("google.protobuf.Timestamp", timestampSlot)).toBe(true);
    // An instance is not JSON: its CEL type satisfies no slot that declares one.
    expect(celTypeSatisfiesJsonSchema("google.protobuf.Timestamp", { type: "string" })).toBe(false);
    expect(celTypeSatisfiesJsonSchema("bytes", { type: "string" })).toBe(false);
    // ...and a slot that holds an instance takes no other concrete CEL type.
    expect(celTypeSatisfiesJsonSchema("string", timestampSlot)).toBe(false);
    expect(celTypeSatisfiesJsonSchema("google.protobuf.Duration", timestampSlot)).toBe(false);
    // An untyped expression still says nothing either way.
    expect(celTypeSatisfiesJsonSchema("dyn", timestampSlot)).toBe(true);
  });

  it("reports comparing a timestamp to a string as a type error", () => {
    expect(analyze("variables.opens == '2026-01-15T09:30:00Z'").diagnostics.map((d) => d.code)).toEqual([
      "CEL_TYPE_ERROR",
    ]);
  });
});
