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

  it("vcs-url: a host label of 100k hyphens is judged quickly", () => {
    const started = Date.now();
    expect(teloFormatFailure("vcs-url", `git+https://a${"-".repeat(100_000)}!/x`)).toBeDefined();
    expect(teloFormatFailure("vcs-url", `git+https://a${"-".repeat(100_000)}/x`)).toBeDefined();
    expect(teloFormatFailure("vcs-url", "git+https://a-b.example.test/x")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("package-url: a vcs_url qualifier is refused at its pair, naming the purl without it", () => {
    const value = "pkg:generic/engine?arch=x86&vcs_url=git%2Bhttps%3A%2F%2Fgit.example.test%2Facme%2Fengine%40a5333afb9ad1aa473f8963b92caeaa955f47dc74";
    expect(teloFormatFailure("package-url", value)).toEqual({
      reason:
        "it carries a vcs_url qualifier. The repository and commit are declared beside the package URL as " +
        "`vcs: { url, revision }`; write pkg:generic/engine?arch=x86",
      offset: "pkg:generic/engine?arch=x86&".length,
    });
    expect(teloFormatFailure("package-url", "pkg:generic/engine?vcs_url=x#sub")?.reason).toMatch(/; write pkg:generic\/engine#sub$/);
  });

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
      join(src, "package-url-format.ts"),
      join(src, "cpe-format.ts"),
      join(src, "vcs-url-format.ts"),
      join(src, "vcs-revision-format.ts"),
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
