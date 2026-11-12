import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYamlText } from "../src/parse-loaded-file.js";
import type { Range } from "../src/types.js";

// `templating/tag-conformance/loader-positions.json`, which the Rust loader runs too.
const rows = JSON.parse(
  readFileSync(new URL("../../../templating/tag-conformance/loader-positions.json", import.meta.url), "utf8"),
) as {
  name: string;
  yaml: string;
  refusals: { documentIndex: number; code: string; message: string; range?: number[] }[];
  documents?: { sourceLine: number; positions: Record<string, number[]> }[];
}[];

const compact = (range: Range) => [range.start.line, range.start.character, range.end.line, range.end.character];

describe("loader-positions.json", () => {
  for (const row of rows) {
    it(row.name, () => {
      const { parseErrors, positions } = parseYamlText(row.yaml);
      expect(
        parseErrors.map((e) => ({
          documentIndex: e.documentIndex,
          // The code the loader reports the error under (`collectParseDiagnostics`).
          code: e.code ?? "MANIFEST_PARSE_FAILED",
          message: e.message,
          ...(e.range ? { range: compact(e.range) } : {}),
        })),
      ).toEqual(row.refusals);
      if (row.documents) {
        // Compared as text, so the order fields are filed in is part of the answer.
        const found = positions.map((d) => ({
          sourceLine: d.sourceLine,
          positions: Object.fromEntries([...d.positionIndex].map(([path, range]) => [path, compact(range)])),
        }));
        expect(JSON.stringify(found)).toBe(JSON.stringify(row.documents));
      }
    });
  }
});
