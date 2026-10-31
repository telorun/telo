import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { assembleGraphDiagnostics } from "../src/graph-diagnostics.js";
import { Loader } from "../src/manifest-loader.js";
import type { AnalysisDiagnostic, ManifestSource } from "../src/types.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/__fixtures__/check-run-agreement/expansion",
);

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

/** What `telo check` reports for a fixture: the load's refusals and the analysis. */
async function check(file: string): Promise<AnalysisDiagnostic[]> {
  const graph = await new Loader([fileSource]).loadGraph(join(FIXTURES, file), { desugarImports: true });
  const analysis = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
    moduleDocuments: collectModuleDocuments(graph),
  });
  return assembleGraphDiagnostics(graph, analysis).diagnostics;
}

const EXPANSION_CODES = new Set([
  "BRANCH_POSITION_INVALID",
  "BRANCH_SHAPE_INVALID",
  "REPEAT_OUTSIDE_TEMPLATE",
  "REPEAT_POSITION_INVALID",
  "REPEAT_SHAPE_INVALID",
  "REF_MEMBER_INVALID",
]);

describe("expansion refusals", () => {
  it("report a tag as a file's first document once, and nothing else about it", async () => {
    const diagnostics = await check("first-document.yaml");
    expect(diagnostics.map((d) => d.code)).toEqual(["BRANCH_POSITION_INVALID"]);
  });

  for (const fixture of [
    "branch-position/telo.yaml",
    "branch-shape/telo.yaml",
    "repeat/telo.yaml",
    "ref-member/telo.yaml",
    "loader-position/telo.yaml",
    "loader-position/entry.yaml",
    "on-sequence.yaml",
  ]) {
    it(`are the only findings at and beneath each refused construct — ${fixture}`, async () => {
      const diagnostics = await check(fixture);
      const refusals = diagnostics.filter((d) => EXPANSION_CODES.has(String(d.code)));
      expect(refusals.length).toBeGreaterThan(0);
      const pathOf = (d: AnalysisDiagnostic) => (d.data as { path?: string } | undefined)?.path;
      const beneath = (path: string | undefined, prefix: string | undefined) =>
        path !== undefined &&
        prefix !== undefined &&
        (prefix === "" || path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`));
      const others = diagnostics.filter(
        (d) => !EXPANSION_CODES.has(String(d.code)) && refusals.some((r) => beneath(pathOf(d), pathOf(r))),
      );
      expect(others.map((d) => `${d.code} ${pathOf(d)}: ${d.message}`)).toEqual([]);
      // Each refused construct is reported once.
      const keys = refusals.map((d) => `${d.code} ${pathOf(d)} ${d.message}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }

  it("leave a consumer of a refused library silent", async () => {
    for (const fixture of ["branch-position", "branch-shape", "repeat", "ref-member"]) {
      expect(await check(`${fixture}/app.yaml`)).toEqual([]);
    }
  });
});

describe("expansion positions", () => {
  it("admit each tag in the form its position takes", async () => {
    const graph = await new Loader([fileSource]).loadGraph(
      resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/expansion-legal.yaml"),
      { desugarImports: true },
    );
    const diagnostics = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
      moduleDocuments: collectModuleDocuments(graph),
    });
    expect(diagnostics.filter((d) => EXPANSION_CODES.has(String(d.code)))).toEqual([]);
  });
});
