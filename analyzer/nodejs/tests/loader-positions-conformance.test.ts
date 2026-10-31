import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYamlText } from "../src/parse-loaded-file.js";

// `templating/tag-conformance/loader-positions.json`, which the Rust loader runs too.
const rows = JSON.parse(
  readFileSync(new URL("../../../templating/tag-conformance/loader-positions.json", import.meta.url), "utf8"),
) as { name: string; yaml: string; refusals: { documentIndex: number; code: string }[] }[];

describe("loader-positions.json", () => {
  for (const row of rows) {
    it(row.name, () => {
      const { parseErrors } = parseYamlText(row.yaml);
      expect(parseErrors.map((e) => ({ documentIndex: e.documentIndex, code: e.code }))).toEqual(
        row.refusals,
      );
    });
  }
});
