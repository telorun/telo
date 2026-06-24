import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { selectByPatterns, type SelectOptions } from "../src/glob-select.js";

// The language-neutral conformance suite (`packages/glob/conformance/glob.json`)
// is the cross-runtime contract: any Telo runtime (Rust / Go later) must produce
// identical output for these cases. The Node engine is verified against it here.
interface GlobCase {
  name: string;
  patterns: string[];
  paths: string[];
  options?: SelectOptions;
  selected: string[];
}

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../conformance/glob.json", import.meta.url)), "utf8"),
) as { cases: GlobCase[] };

describe("glob conformance (packages/glob/conformance/glob.json)", () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      expect(selectByPatterns(c.paths, c.patterns, c.options ?? {})).toEqual(c.selected);
    });
  }
});
