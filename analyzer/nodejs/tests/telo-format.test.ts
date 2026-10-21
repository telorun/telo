import { readFileSync, readdirSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TELO_FORMATS, teloFormatFailure } from "../src/telo-format.js";

describe("Telo formats", () => {
  for (const entry of TELO_FORMATS.values()) {
    it(`${entry.name}: the checker agrees with the entry's conformance set`, () => {
      const accepted = entry.conformance.valid.filter((v) => teloFormatFailure(entry.name, v));
      const refused = entry.conformance.invalid.filter((v) => !teloFormatFailure(entry.name, v));
      expect({ accepted, refused }).toEqual({ accepted: [], refused: [] });
    });
  }

  it("re2-pattern: every conforming value compiles as an ECMAScript u-mode pattern", () => {
    const entry = TELO_FORMATS.get("re2-pattern")!;
    const refused = entry.conformance.valid.filter((value) => {
      try {
        new RegExp(value, "u");
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toEqual([]);
  });

  it("the checker's import graph reaches no Node built-in", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = resolve(here, "../src");
    const require = createRequire(join(src, "css-selector-format.ts"));
    const parserDir = join(dirname(require.resolve("css-selector-parser")), "..", "mjs");
    const files = [
      join(src, "telo-format.ts"),
      join(src, "css-selector-format.ts"),
      join(src, "re2-pattern-format.ts"),
      ...readdirSync(parserDir)
        .filter((f) => f.endsWith(".js"))
        .map((f) => join(parserDir, f)),
    ];
    const builtins = new Set(builtinModules);
    const reached = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/\bfrom\s+["']([^"']+)["']/g)]
        .map((match) => match[1]!)
        .filter((spec) => spec.startsWith("node:") || builtins.has(spec.split("/")[0]!))
        .map((spec) => `${file}: ${spec}`),
    );
    expect(reached).toEqual([]);
  });
});
