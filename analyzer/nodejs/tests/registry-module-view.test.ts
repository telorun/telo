import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** An application and the library it imports both alias `Source`, naming two
 *  different modules — the shape of a load-time flattened set. */
const flattened = withSyntheticPositions([
  { kind: "Telo.Application", metadata: { name: "App" } },
  {
    kind: "Telo.Import",
    metadata: { name: "Source", module: "App", resolvedModuleName: "LeftSource" },
    source: "./left",
  },
  {
    kind: "Telo.Import",
    metadata: { name: "Reader", module: "App", resolvedModuleName: "Reader" },
    source: "./reader",
  },
  {
    kind: "Telo.Import",
    metadata: { name: "Source", module: "Reader", resolvedModuleName: "RightSource" },
    source: "../right",
  },
  {
    kind: "Self.Left",
    metadata: { name: "value", module: "LeftSource", forwardedExport: true },
  },
  {
    kind: "Self.Right",
    metadata: { name: "value", module: "RightSource", forwardedExport: true },
  },
] as unknown as ResourceManifest[]);

function loadTimeRegistry(): AnalysisRegistry {
  const registry = new AnalysisRegistry();
  new StaticAnalyzer().analyze(flattened, { skipValidation: true }, registry);
  return registry;
}

describe("AnalysisRegistry.forModule", () => {
  it("normalizes a library's `!ref Alias.name` through the library's own imports", () => {
    const registry = loadTimeRegistry();
    const library = withSyntheticPositions([
      { kind: "Telo.Library", metadata: { name: "Reader" } },
      {
        kind: "Reader.Holder",
        metadata: { name: "read", module: "Reader" },
        target: makeTaggedSentinel("ref", "Source.value"),
      },
    ] as unknown as ResourceManifest[]);

    const normalized = new StaticAnalyzer().normalize(
      library,
      registry.forModule("Reader"),
      flattened,
    );

    expect((normalized.find((m) => m.metadata.name === "read") as { target?: unknown }).target)
      .toEqual({ kind: "RightSource.Right", name: "value", alias: "Source" });
  });

  it("analyzes a library into the shared registry without touching the entry's table", () => {
    const registry = loadTimeRegistry();
    const view = registry.forModule("Detached");
    new StaticAnalyzer().analyze(
      withSyntheticPositions([
        { kind: "Telo.Library", metadata: { name: "Detached" } },
        {
          kind: "Telo.Import",
          metadata: { name: "Dep", module: "Detached", resolvedModuleName: "DepModule" },
          source: "./dep",
        },
      ] as unknown as ResourceManifest[]),
      { skipValidation: true },
      view,
    );

    expect(view.resolveKind("Dep.Thing")).toBe("DepModule.Thing");
    expect(view.resolveKind("Self.Thing")).toBe("Detached.Thing");
    expect(registry.resolveKind("Dep.Thing")).toBeUndefined();
    expect(registry.resolveKind("Source.Thing")).toBe("LeftSource.Thing");
  });
});
