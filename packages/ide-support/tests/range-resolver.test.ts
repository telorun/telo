import type { AnalysisDiagnostic, PositionIndex, Range } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { resolveRange } from "../src/diagnostics/range-resolver.js";

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
