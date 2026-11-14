import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import type { AnalysisDiagnostic } from "../src/types.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/** `x-telo-context-withheld`: a binding or member named at a site and holding
 *  no value there, read by no expression — through a referrer as well. */

const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/context-withheld");

async function analysis(file: string): Promise<AnalysisDiagnostic[]> {
  const loaded = await loadFile(join(FIXTURES, file));
  return new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
}

const findings = (diagnostics: AnalysisDiagnostic[]) =>
  diagnostics
    .filter((d) => d.severity === 1)
    .map((d) => `${d.code} ${(d.data as { path?: string }).path}: ${d.message}`)
    .sort();

describe("withheld context nodes", () => {
  it("refuses every read of a withheld binding or member, naming who withholds it", async () => {
    expect(findings(await analysis("telo.yaml"))).toEqual([
      // The box's own regions: a binding, and a member beneath a typed one.
      "CEL_UNKNOWN_FIELD note: Kinds.Box/box: !cel: 'request.principal' is not available here: a box knows no principal.",
      "CEL_UNKNOWN_IDENTIFIER parts[0].when: Kinds.Box/box: !cel: 'request' is not available here — Kinds.Box/box withholds it: a box is drawn once, with no request.",
      // A guarded read through the referrer is refused all the same, and an
      // inline holder is named as one; the part placed in the page reads freely.
      "CEL_UNKNOWN_IDENTIFIER parts[1].parts[0].when: Kinds.Page/page: !cel: 'request' is not available here — the inline Kinds.Box withholds it: a box is drawn once, with no request.",
      "CEL_UNKNOWN_IDENTIFIER title: Kinds.Box/box: !cel: 'request' is not available here: a box is drawn once, with no request.",
    ]);
  }, 120_000);

  it("refuses the mark off a binding or beside a type, and one holding no sentence", async () => {
    const diagnostics = (await analysis("invalid/telo.yaml")).filter(
      (d) => d.code === "CONTEXT_WITHHELD_INVALID" || d.code === "SCHEMA_VIOLATION",
    );
    expect(diagnostics.map((d) => [d.code, (d.data as { path?: string }).path]).sort()).toEqual([
      ["CONTEXT_WITHHELD_INVALID", "schema.properties.off.x-telo-context-withheld"],
      ["CONTEXT_WITHHELD_INVALID", "schema.properties.typed.x-telo-context.properties.request.x-telo-context-withheld"],
      ["SCHEMA_VIOLATION", "schema.properties.typed.x-telo-context.properties.empty.x-telo-context-withheld"],
    ]);
  }, 120_000);
});
