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

const sqlExecKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Exec", module: "sql" },
  capability: "Telo.Runnable",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

describe("validateProviderCoherence", () => {
  it("rejects `provide:` on a non-Telo.Provider definition", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Wrong", module: "test" },
      capability: "Telo.Invocable",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      provide: { kind: "http-client.Request", name: "r" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_ON_NON_PROVIDER");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("Telo.Provider");
  });

  it("rejects co-occurrence of `provide:` with `invoke:`", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Conflict", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      provide: { kind: "http-client.Request", name: "r" },
      invoke: { kind: "http-client.Request", name: "r" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_DISPATCHER_CONFLICT");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("invoke");
  });

  it("rejects co-occurrence of `provide:` with `run:`", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Conflict", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      provide: { kind: "http-client.Request", name: "r" },
      run: "r",
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_DISPATCHER_CONFLICT");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("run");
  });

  it("rejects `provide.name` that does not match any `resources:` entry", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "MissingTarget", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "actualName" } }],
      provide: { kind: "http-client.Request", name: "wrongName" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_TARGET_UNKNOWN");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("wrongName");
  });

  it("rejects `provide.name` pointing at a non-Telo.Invocable target", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "WrongCapability", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "sql.Exec", metadata: { name: "r" } }],
      provide: { kind: "sql.Exec", name: "r" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([sqlExecKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_TARGET_NOT_INVOCABLE");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("Telo.Invocable");
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

  it("rejects `provide.kind` that disagrees with the matched `resources:` entry's kind", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "MismatchedKind", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      // Same name `r` as the resource entry, but provide.kind names a
      // different kind. Runtime dispatches by name → it'd invoke Http.Request;
      // analyzer types `result:` against `sql.Exec` → false typing.
      provide: { kind: "sql.Exec", name: "r" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, sqlExecKind, def]));
    const violations = diagnostics.filter((d) => d.code === "PROVIDE_KIND_MISMATCH");
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("sql.Exec");
    expect(violations[0].message).toContain("http-client.Request");
  });

  it("accepts a well-formed template provider", () => {
    const def: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "GoodProvider", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", additionalProperties: true },
      resources: [{ kind: "http-client.Request", metadata: { name: "r" } }],
      provide: { kind: "http-client.Request", name: "r" },
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([httpRequestKind, def]));
    const violations = diagnostics.filter((d) =>
      d.code === "PROVIDE_ON_NON_PROVIDER" ||
      d.code === "PROVIDE_DISPATCHER_CONFLICT" ||
      d.code === "PROVIDE_TARGET_UNKNOWN" ||
      d.code === "PROVIDE_TARGET_NOT_INVOCABLE" ||
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
