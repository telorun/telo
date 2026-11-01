import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import type { AnalysisDiagnostic } from "../src/types.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * A consumer's check judges every body entry as that consumer instantiates it:
 * forwarded values over the body's literals, and a sibling reference as that
 * sibling's own instance — so a rule reading across entries judges each
 * consumer's real wiring.
 */
const APP = join(ROOT, "analyzer/nodejs/tests/__fixtures__/template-entry-views/app/telo.yaml");

let found: AnalysisDiagnostic[];
beforeAll(async () => {
  const loaded = await loadFile(APP);
  found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
}, 120_000);

const at = (code: string) =>
  found
    .filter((d) => d.code === code)
    .map((d) => [(d.data as { resource?: { name?: string } }).resource?.name, (d.data as { path?: string }).path]);

describe("a body entry as each consumer instantiates it", () => {
  it("judges a rule reaching through a sibling entry by each consumer's own values", () => {
    expect(at("REFERRER_RULE_VIOLATED")).toEqual([
      ["badAdmin", "layout"],
      ["shared", "layout"],
    ]);
  });

  it("reports a finding at a place the body wrote, which the definition's check does not make, at each consumer", () => {
    const mismatches = found.filter((d) => d.code === "REFERENCE_KIND_MISMATCH");
    expect(mismatches.map((d) => [(d.data as { resource?: { name?: string } }).resource?.name, (d.data as { path?: string }).path])).toEqual([
      ["crossed", ""],
    ]);
    expect(mismatches[0]!.message).toMatch(/^Views\.Crossed\/crossed: `Views\.Crossed` body entry `listing`, field `presentation`: /);
  });

  it("resolves a body reference in the defining module, never to a consumer's resource of the same name", () => {
    expect(at("UNRESOLVED_REFERENCE")).toEqual([]);
    expect(at("REFERRER_RULE_INVALID")).toEqual([]);
    // Unexported, the presentation is not held here: the rule says it did not run.
    expect(at("REFERRER_RULE_SKIPPED")).toEqual([["hidden", "layout"]]);
  });
});
