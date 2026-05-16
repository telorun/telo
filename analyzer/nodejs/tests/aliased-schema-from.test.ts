import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";

/** A carrier library that publishes a value-shape schema as $defs on a
 *  Telo.Type definition. Models @telorun/http-dispatch publishing Outcomes. */
const carrierLibrary: ResourceManifest = {
  kind: "Telo.Library",
  metadata: { name: "http-dispatch", namespace: "std" },
  exports: { kinds: ["Outcomes"] },
} as unknown as ResourceManifest;

const carrierDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Outcomes", module: "http-dispatch", namespace: "std" },
  capability: "Telo.Type",
  schema: {
    type: "object",
    $defs: {
      Returns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            status: { type: "integer", minimum: 100, maximum: 599 },
            mode: { type: "string", enum: ["buffer", "stream"] },
            content: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  // Nested encoder ref — the slot Phase 5 injection must reach
                  // through the schema-from indirection.
                  encoder: { "x-telo-ref": "std/codec#Encoder" },
                },
              },
            },
          },
          required: ["status"],
        },
      },
    },
  },
} as unknown as ResourceManifest;

/** A consumer kind whose `returns` field anchors at the carrier's $defs/Returns
 *  via an import-aliased absolute schema-from path. Models http-server.Server's
 *  notFoundHandler.returns after migration. */
const consumerDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Endpoint", module: "consumer", namespace: "test" },
  capability: "Telo.Service",
  schema: {
    type: "object",
    properties: {
      returns: {
        "x-telo-outcome-list": "returns",
        "x-telo-schema-from": "HttpDispatch.Outcomes/$defs/Returns",
      },
    },
  },
} as unknown as ResourceManifest;

const consumerLibrary: ResourceManifest = {
  kind: "Telo.Library",
  metadata: { name: "consumer", namespace: "test" },
  exports: { kinds: ["Endpoint"] },
} as unknown as ResourceManifest;

/** The consumer library declares its import of http-dispatch under the alias
 *  HttpDispatch. The aliased schema-from must resolve through THIS scope
 *  (the kind owner's), not the user app's. */
const consumerImport: ResourceManifest = {
  kind: "Telo.Import",
  metadata: {
    name: "HttpDispatch",
    module: "consumer",
    resolvedModuleName: "http-dispatch",
    resolvedNamespace: "std",
  },
  source: "../http-dispatch",
} as unknown as ResourceManifest;

/** The user app — does NOT import HttpDispatch. Proves the resolver uses the
 *  kind owner's alias scope, not the consumer's. */
const userApp: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "user-app", version: "1.0.0" },
} as unknown as ResourceManifest;

const userImportOfConsumer: ResourceManifest = {
  kind: "Telo.Import",
  metadata: {
    name: "Cons",
    resolvedModuleName: "consumer",
    resolvedNamespace: "test",
  },
  source: "../consumer",
} as unknown as ResourceManifest;

const baseManifests = [
  userApp,
  userImportOfConsumer,
  consumerLibrary,
  consumerImport,
  consumerDef,
  carrierLibrary,
  carrierDef,
];

describe("x-telo-schema-from with import-aliased absolute paths", () => {
  it("validates a well-formed value against the imported carrier sub-schema", () => {
    const resource: ResourceManifest = {
      kind: "Cons.Endpoint",
      metadata: { name: "Ep" },
      returns: [{ status: 200, mode: "buffer" }],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([...baseManifests, resource]);
    const schemaFromErrors = diagnostics.filter(
      (d) =>
        d.code === "DEPENDENT_SCHEMA_MISMATCH" || d.code === "SCHEMA_FROM_MISSING_PATH",
    );
    expect(schemaFromErrors).toEqual([]);
  });

  it("emits DEPENDENT_SCHEMA_MISMATCH when the value violates the carrier sub-schema", () => {
    const resource: ResourceManifest = {
      kind: "Cons.Endpoint",
      metadata: { name: "Ep" },
      // Missing required `status`. Carrier's $defs/Returns.items requires it.
      returns: [{ mode: "buffer" }],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([...baseManifests, resource]);
    const mismatch = diagnostics.find((d) => d.code === "DEPENDENT_SCHEMA_MISMATCH");
    expect(mismatch).toBeDefined();
    expect(mismatch!.message).toContain("HttpDispatch.Outcomes/$defs/Returns");
    expect(mismatch!.message).toContain("status");
  });

  it("emits DEPENDENT_SCHEMA_MISMATCH on a structurally invalid entry", () => {
    const resource: ResourceManifest = {
      kind: "Cons.Endpoint",
      metadata: { name: "Ep" },
      // status out of range; mode enum violation
      returns: [{ status: 42, mode: "bogus" }],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze([...baseManifests, resource]);
    const mismatches = diagnostics.filter((d) => d.code === "DEPENDENT_SCHEMA_MISMATCH");
    expect(mismatches.length).toBeGreaterThan(0);
  });

  it("emits SCHEMA_FROM_MISSING_PATH when the alias cannot be resolved", () => {
    const brokenDef: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Endpoint", module: "consumer", namespace: "test" },
      capability: "Telo.Service",
      schema: {
        type: "object",
        properties: {
          returns: {
            "x-telo-outcome-list": "returns",
            // Bogus alias — not registered anywhere
            "x-telo-schema-from": "Bogus.Kind/$defs/Returns",
          },
        },
      },
    } as unknown as ResourceManifest;

    const resource: ResourceManifest = {
      kind: "Cons.Endpoint",
      metadata: { name: "Ep" },
      returns: [{ status: 200 }],
    } as unknown as ResourceManifest;

    const manifests = [
      userApp,
      userImportOfConsumer,
      consumerLibrary,
      consumerImport,
      brokenDef,
      carrierLibrary,
      carrierDef,
      resource,
    ];

    const diagnostics = new StaticAnalyzer().analyze(manifests);
    const missing = diagnostics.find((d) => d.code === "SCHEMA_FROM_MISSING_PATH");
    expect(missing).toBeDefined();
    expect(missing!.message).toContain("Bogus.Kind");
  });

  it("normalizes inline resources nested behind an x-telo-schema-from path", () => {
    // The encoder lives inside HttpDispatch.Outcomes/$defs/Returns and the
    // consumer never spells the slot out in its own schema. Without schema-from
    // expansion, the inline `{kind: Codec.Encoder}` survives Phase 2 untouched
    // and Phase 5 has no named ref to inject — exactly the registry-app 500.
    const codecLibrary: ResourceManifest = {
      kind: "Telo.Library",
      metadata: { name: "codec", namespace: "std" },
      exports: { kinds: ["Encoder"] },
    } as unknown as ResourceManifest;

    const codecDef: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Encoder", module: "codec", namespace: "std" },
      capability: "Telo.Invocable",
      schema: { type: "object", additionalProperties: false },
    } as unknown as ResourceManifest;

    const userImportOfCodec: ResourceManifest = {
      kind: "Telo.Import",
      metadata: { name: "Codec", resolvedModuleName: "codec", resolvedNamespace: "std" },
      source: "../codec",
    } as unknown as ResourceManifest;

    // Build the analysis context first (so the registry knows about kinds and
    // import aliases), then normalize a *fresh* manifest list — analyze mutates
    // inline refs in-place, so normalize would otherwise see them already
    // hoisted by the first pass.
    const seedManifests = [
      userApp,
      userImportOfConsumer,
      userImportOfCodec,
      consumerLibrary,
      consumerImport,
      consumerDef,
      carrierLibrary,
      carrierDef,
      codecLibrary,
      codecDef,
    ];

    const registry = new AnalysisRegistry();
    const analyzer = new StaticAnalyzer();
    analyzer.analyze(seedManifests, {}, registry);

    const resource: ResourceManifest = {
      kind: "Cons.Endpoint",
      metadata: { name: "Ep" },
      returns: [
        {
          status: 200,
          mode: "stream",
          content: {
            "application/octet-stream": {
              encoder: { kind: "Codec.Encoder" },
            },
          },
        },
      ],
    } as unknown as ResourceManifest;

    const normalized = analyzer.normalize([...seedManifests, resource], registry);

    const encoderRef = (
      (normalized.find((m) => m.metadata?.name === "Ep") as any)?.returns?.[0]?.content?.[
        "application/octet-stream"
      ] as { encoder?: { kind?: string; name?: string } } | undefined
    )?.encoder;
    expect(encoderRef).toBeDefined();
    expect(typeof encoderRef!.name).toBe("string");
    expect(encoderRef!.kind).toBe("Codec.Encoder");
    const extracted = normalized.find((m) => m.metadata?.name === encoderRef!.name);
    expect(extracted, `expected to find extracted manifest for ${encoderRef!.name}`).toBeDefined();
    expect(extracted!.kind).toBe("Codec.Encoder");

    // The schema-from-derived ref must also produce a DAG edge so the kernel
    // initializes the encoder before its parent; without this, Phase 5
    // injection fires against a not-yet-created dependency at boot.
    const { order, cycleError } = analyzer.prepare(normalized, registry);
    expect(cycleError).toBeNull();
    expect(order).not.toBeNull();
    const epIdx = order!.indexOf("Ep");
    const encIdx = order!.indexOf(encoderRef!.name);
    expect(encIdx).toBeGreaterThanOrEqual(0);
    expect(epIdx).toBeGreaterThanOrEqual(0);
    expect(encIdx).toBeLessThan(epIdx);
  });

  it("persists aliasesByModule across analyze() → prepare() so schema-from resolution still works in the kernel-boot path", () => {
    // The kernel's boot sequence is:
    //   1. analyzer.analyzeErrors(manifests, {}, registry) — populates aliases
    //      AND aliasesByModule on the registry.
    //   2. analyzer.prepare(manifests, registry) — re-runs validateReferences
    //      with registry._context().
    // Before the persistence fix, step 2 saw an empty aliasesByModule because
    // analyze() built it locally, so library-private schema-from anchors
    // like "HttpDispatch.Outcomes/$defs/Returns" silently failed at boot.
    const resource: ResourceManifest = {
      kind: "Cons.Endpoint",
      metadata: { name: "Ep" },
      returns: [{ status: 200, mode: "buffer" }],
    } as unknown as ResourceManifest;
    const manifests = [...baseManifests, resource];

    const registry = new AnalysisRegistry();
    const analyzer = new StaticAnalyzer();
    const analyzeDiagnostics = analyzer.analyze(manifests, {}, registry);
    expect(
      analyzeDiagnostics.filter(
        (d) =>
          d.severity === DiagnosticSeverity.Error &&
          (d.code === "SCHEMA_FROM_MISSING_PATH" || d.code === "DEPENDENT_SCHEMA_MISMATCH"),
      ),
    ).toEqual([]);

    const { diagnostics: prepareDiagnostics } = analyzer.prepare(manifests, registry);
    expect(
      prepareDiagnostics.filter(
        (d) =>
          d.code === "SCHEMA_FROM_MISSING_PATH" || d.code === "DEPENDENT_SCHEMA_MISMATCH",
      ),
    ).toEqual([]);
  });
});
