import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const httpRequestKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Request", module: "http-client" },
  capability: "Telo.Invocable",
  outputType: {
    type: "object",
    additionalProperties: false,
    properties: { body: { type: "object", additionalProperties: true } },
  },
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

const ref = (source: string) => ({ __tagged: true, engine: "ref", source });

describe("validateProviderCoherence", () => {
  it("rejects `provide:` on a non-Telo.Provider definition", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Wrong", module: "test" },
      capability: "Telo.Invocable",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      provide: ref("r"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_ON_NON_PROVIDER");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("Telo.Provider");
  });

  it("rejects co-occurrence of `provide:` with `invoke:`", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Both", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      provide: ref("r"),
      invoke: ref("r"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_DISPATCHER_CONFLICT");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("invoke");
  });

  it("rejects co-occurrence of `provide:` with `run:`", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Both", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      provide: ref("r"),
      run: ref("r"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_DISPATCHER_CONFLICT");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("run");
  });

  it("rejects a Telo.Provider definition lacking both `controllers:` and `provide:`", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Empty", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDER_MISSING_IMPLEMENTATION");
    expect(violations.length).toBe(1);
  });

  it("accepts a well-formed template provider", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "GoodProvider", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      provide: ref("r"),
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) =>
      d.code === "PROVIDE_ON_NON_PROVIDER" ||
      d.code === "PROVIDE_DISPATCHER_CONFLICT" ||
      d.code === "TEMPLATE_DISPATCH_UNKNOWN" ||
      d.code === "INVALID_REFERENCE_FORM" ||
      d.code === "PROVIDER_MISSING_IMPLEMENTATION",
    );
    expect(violations).toEqual([]);
  });

  it("accepts a TS-backed Telo.Provider with controllers: and no provide:", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "TsBacked", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      controllers: ["pkg:npm/example@1.0.0?local_path=./nodejs#example"],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDER_MISSING_IMPLEMENTATION");
    expect(violations).toEqual([]);
  });
});
