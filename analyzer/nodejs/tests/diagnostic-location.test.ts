import { describe, expect, it } from "vitest";
import { findPositions, resolveRange } from "../src/diagnostic-location.js";
import type { LoadedFile, LoadedGraph } from "../src/loaded-types.js";
import type { AnalysisDiagnostic, PositionIndex, Range } from "../src/types.js";

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

const fieldRange: Range = {
  start: { line: 4, character: 2 },
  end: { line: 4, character: 12 },
};
const parentRange: Range = {
  start: { line: 3, character: 2 },
  end: { line: 4, character: 20 },
};

function diagnosticWithPath(path: string): AnalysisDiagnostic {
  return {
    severity: 1,
    code: "SCHEMA_VIOLATION",
    source: "telo",
    message: `${path} is missing required property 'type'`,
    data: { path },
  } as unknown as AnalysisDiagnostic;
}

describe("resolveRange", () => {
  it("returns the indexed range for a matching path", () => {
    const positionIndex: PositionIndex = new Map([
      ["secrets.openaiApiKey", fieldRange],
    ]);
    const range = resolveRange(diagnosticWithPath("secrets.openaiApiKey"), {
      positionIndex,
      sourceLine: 0,
    });
    expect(range).toEqual(fieldRange);
  });

  it("prefers the parent's key range when the leaf is missing", () => {
    const keyRange: Range = {
      start: { line: 3, character: 2 },
      end: { line: 3, character: 14 },
    };
    const positionIndex: PositionIndex = new Map<string, Range>([
      ["secrets.openaiApiKey", parentRange],
      ["@key:secrets.openaiApiKey", keyRange],
    ]);
    const range = resolveRange(
      diagnosticWithPath("secrets.openaiApiKey.type"),
      { positionIndex, sourceLine: 0 },
    );
    expect(range).toEqual(keyRange);
  });

  it("falls back to the parent's value range when no key range is recorded", () => {
    const positionIndex: PositionIndex = new Map([
      ["secrets.openaiApiKey", parentRange],
    ]);
    const range = resolveRange(
      diagnosticWithPath("secrets.openaiApiKey.type"),
      { positionIndex, sourceLine: 0 },
    );
    expect(range).toEqual(parentRange);
  });

  it("walks across array indices when the leaf is missing", () => {
    const arrayItemKey: Range = {
      start: { line: 7, character: 4 },
      end: { line: 7, character: 10 },
    };
    const positionIndex: PositionIndex = new Map<string, Range>([
      ["@key:routes[0]", arrayItemKey],
    ]);
    const range = resolveRange(diagnosticWithPath("routes[0].handler"), {
      positionIndex,
      sourceLine: 0,
    });
    expect(range).toEqual(arrayItemKey);
  });

  it("falls back to sourceLine when no parent path matches", () => {
    const range = resolveRange(diagnosticWithPath("secrets.openaiApiKey.type"), {
      positionIndex: new Map(),
      sourceLine: 12,
    });
    expect(range.start.line).toBe(12);
    expect(range.end.line).toBe(12);
  });
});
