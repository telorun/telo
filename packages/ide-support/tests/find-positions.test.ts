import type { LoadedFile, LoadedGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { findPositions } from "../src/diagnostics/find-positions.js";

function file(source: string, sourceLine: number): LoadedFile {
  return {
    source,
    manifests: [{ kind: "Telo.Library", metadata: { name: "Shared" } }],
    positions: [{ sourceLine, positionIndex: new Map() }],
  } as unknown as LoadedFile;
}

describe("findPositions", () => {
  it("locates a resource in the file the diagnostic names when two modules declare its name", () => {
    const first = file("file:///ws/v2/telo.yaml", 0);
    const second = file("file:///ws/v1/telo.yaml", 7);
    const graph = {
      modules: new Map([
        [first.source, { owner: first, partials: [] }],
        [second.source, { owner: second, partials: [] }],
      ]),
    } as unknown as LoadedGraph;

    const located = findPositions(graph, {
      resource: { kind: "Telo.Library", name: "Shared" },
      filePath: "file:///ws/v1/telo.yaml",
      path: "needs.thing.kind",
    });

    expect(located?.file).toBe("file:///ws/v1/telo.yaml");
    expect(located?.sourceLine).toBe(7);
  });
});
