import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import type { AnalysisDiagnostic } from "../src/types.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/** A resource rule's `reachable:` — `this` is every declaration a reference of
 *  the kind names, at a slot of the use, reachable from the resource through
 *  slots and step `invoke:` targets whose use is in `through`. */

const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/resource-rule-reachable");

async function analysis(file: string): Promise<AnalysisDiagnostic[]> {
  const loaded = await loadFile(join(FIXTURES, file));
  return new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
}

const ruleFindings = (diagnostics: AnalysisDiagnostic[]) =>
  diagnostics
    .filter((d) => d.code.startsWith("RESOURCE_RULE_"))
    .map((d) => `${d.code} ${d.data?.resource?.name} ${(d.data as { path?: string }).path ?? ""}`.trimEnd())
    .sort();

describe("resource rules — reachable", () => {
  it("judges every reference it reaches, anchored where the entry's own modules wrote it", async () => {
    const diagnostics = await analysis("telo.yaml");
    // `home` and the library's `guide` are listed — `guide` through its alias,
    // reached through the library's own bare `!ref guide` too; a page title
    // holding an expression is compared by identity, not skipped. The `Shallow`
    // rule walks no call slot, so it never reaches a step target.
    expect(ruleFindings(diagnostics)).toEqual([
      // A step target written inline, a step target named, one in a `catch:` branch.
      "RESOURCE_RULE_VIOLATED flow steps[1].invoke.page",
      "RESOURCE_RULE_VIOLATED flow steps[2].catch[0].invoke.page",
      // The library's sequence, entered through this step.
      "RESOURCE_RULE_VIOLATED flow steps[3].invoke",
      "RESOURCE_RULE_VIOLATED openDraft page",
      // The library's bar, entered through this slot.
      "RESOURCE_RULE_VIOLATED site layout.header[0]",
      // A bar written inline in an inline layout.
      "RESOURCE_RULE_VIOLATED site layout.header[1].items[1].page",
      // A page named at an accessor field; an address there names none.
      "RESOURCE_RULE_VIOLATED site layout.header[1].items[3].href",
    ]);
    expect(diagnostics.some((d) => d.code === "DEPENDENCY_CYCLE")).toBe(false);
  }, 120_000);

  it("names the resource the rule belongs to, and what it reached in a dependency", async () => {
    const messages = (await analysis("telo.yaml"))
      .filter((d) => d.code === "RESOURCE_RULE_VIOLATED")
      .map((d) => d.message);
    expect(messages).toContain("Reach.Site/site: names a page the site does not list. (the Reach.Page Docs.orphan, reached through Docs.nav)");
    expect(messages).toContain("Reach.Site/site: names a page the site does not list. (the Reach.Page Docs.orphan, reached through Docs.tour)");
    expect(messages).toContain("Reach.Site/site: names a page the site does not list.");
  }, 120_000);

  it("is skipped, naming the hop, where the walk cannot cross a reference", async () => {
    expect(ruleFindings(await analysis("unresolved.yaml"))).toEqual(["RESOURCE_RULE_SKIPPED site layout"]);
  }, 120_000);

  it("is unexercised when no resource of the kind reaches anything", async () => {
    expect(ruleFindings(await analysis("own.yaml"))).toEqual([
      "RESOURCE_RULE_UNEXERCISED Walker schema.x-telo-resource-rules[0]",
    ]);
  }, 120_000);

  it("refuses a malformed declaration at the kind", async () => {
    const diagnostics = (await analysis("invalid/telo.yaml")).filter((d) => d.code === "RESOURCE_RULE_INVALID");
    expect(diagnostics.map((d) => [(d.data as { path?: string }).path, d.message.split(".")[0]]).sort()).toEqual([
      ["schema.x-telo-resource-rules[0]", "rule BOTH declares both 'in' and 'reachable'; a rule iterates one of them"],
      ["schema.x-telo-resource-rules[1].reachable.through", "rule BAD_USE: 'through' must name at least one use"],
      ["schema.x-telo-resource-rules[1].reachable.use", "rule BAD_USE: 'use' must be one of schema, dependency, call, detached, trigger"],
      ["schema.x-telo-resource-rules[2].reachable.kind", "x-telo-resource-rules 'reachable"],
      ["schema.x-telo-resource-rules[2].reachable.through[1]", "rule BAD_KIND: 'through' must name uses among schema, dependency, call, detached, trigger"],
    ]);
  }, 120_000);
});
