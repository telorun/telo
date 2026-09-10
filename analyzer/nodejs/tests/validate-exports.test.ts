import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A library's export list is resolved where it is written. Every case here
 * used to pass at the library and fail in a CONSUMER's file.
 */

const httpClientKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Client", module: "http-client" },
  capability: "Telo.Service",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

const httpImport: ResourceManifest = {
  kind: "Telo.Import",
  metadata: { name: "Http", module: "lib", resolvedModuleName: "http-client", exportedKinds: ["Client"] },
  source: "http-client",
} as unknown as ResourceManifest;

function library(exports: Record<string, unknown>, extra: ResourceManifest[] = []): ResourceManifest[] {
  return [
    { kind: "Telo.Library", metadata: { name: "lib", module: "lib" }, exports } as unknown as ResourceManifest,
    httpImport,
    httpClientKind,
    {
      kind: "Telo.Definition",
      metadata: { name: "Op", module: "lib" },
      capability: "Telo.Invocable",
      schema: { type: "object" },
      controllers: ["pkg:npm/x@1.0.0#Op"],
    } as unknown as ResourceManifest,
    { kind: "Http.Client", metadata: { name: "api", module: "lib" }, baseUrl: "https://x" } as unknown as ResourceManifest,
    ...extra,
  ];
}

function analyze(manifests: ResourceManifest[]) {
  return new StaticAnalyzer().analyze(withSyntheticPositions(manifests));
}

const codes = (diags: { code: string }[], code: string) => diags.filter((d) => d.code === code);

describe("validateExports", () => {
  it("accepts a declared kind, a re-exported kind, a local instance and a re-exported instance", () => {
    const diags = analyze(
      library(
        { kinds: ["Op", "Http.Client"], resources: ["api", "Http.shared"] },
        [{ kind: "Http.Client", metadata: { name: "shared", module: "http-client", forwardedExport: true } } as unknown as ResourceManifest],
      ),
    );
    expect(codes(diags, "EXPORT_KIND_UNKNOWN")).toEqual([]);
    expect(codes(diags, "EXPORT_RESOURCE_UNKNOWN")).toEqual([]);
  });

  it("reports a kind the library never declared, with the nearest name", () => {
    const diags = analyze(library({ kinds: ["Opp"] }));
    const unknown = codes(diags, "EXPORT_KIND_UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].data?.path).toBe("exports.kinds[0]");
    expect(unknown[0].message).toContain("Declared: Op");
    expect(unknown[0].data?.fix).toEqual({ replacement: "Op" });
  });

  it("names the re-export spelling when a bare name is an imported kind", () => {
    const diags = analyze(library({ kinds: ["Client"] }));
    const unknown = codes(diags, "EXPORT_KIND_UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].message).toContain("it is 'Http.Client', an imported kind");
    expect(unknown[0].data?.fix).toEqual({ replacement: "Http.Client" });
  });

  it("reports a re-export through an alias that is not an import", () => {
    const diags = analyze(library({ kinds: ["Web.Client"], resources: ["Web.api"] }));
    expect(codes(diags, "EXPORT_KIND_UNKNOWN")).toHaveLength(1);
    expect(codes(diags, "EXPORT_KIND_UNKNOWN")[0].message).toContain("Imports: Http");
    expect(codes(diags, "EXPORT_RESOURCE_UNKNOWN")).toHaveLength(1);
  });

  it("reports an instance the library never declared", () => {
    const diags = analyze(library({ resources: ["noSuchInstance"] }));
    const unknown = codes(diags, "EXPORT_RESOURCE_UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].data?.path).toBe("exports.resources[0]");
    expect(unknown[0].message).toContain("Declared: api");
  });

  it("reports a re-exported instance the import does not export", () => {
    const diags = analyze(
      library({ resources: ["Http.missing"] }, [
        { kind: "Http.Client", metadata: { name: "shared", module: "http-client", forwardedExport: true } } as unknown as ResourceManifest,
      ]),
    );
    const unknown = codes(diags, "EXPORT_RESOURCE_UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].message).toContain("Exported: shared");
  });
});
