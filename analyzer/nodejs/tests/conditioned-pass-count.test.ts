import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeConditionedPasses, observePassBranches, type ConditionedPass } from "../src/cel-site-judgements.js";
import { flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

const PASSES: ConditionedPass[] = ["duplicateNames", "unusedDeclarations", "sinkAttachment", "observedStateDeclarations", "markReach", "ruleAbsence", "scopedDuplicates", "scopedSinks", "cycles", "rethrowPlacement", "zoneRequirements", "zoneViolations", "durableRegions", "throwsCoverage", "resourceInputs", "optionalInputReferences", "templateBody", "templateForwards", "needTable", "texts", "moduleDocuments", "kindDocuments", "scopedKindDocuments", "expansion", "importHostPaths", "scopedImportCollisions"];

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** How often each pass is read over the union, and in each branch no
 *  configuration takes, while `analyze` runs. */
function passReads(analyze: () => void): { union: Map<ConditionedPass, number>; branches: Map<ConditionedPass, object[]> } {
  const union = new Map<ConditionedPass, number>();
  const branches = new Map<ConditionedPass, object[]>();
  const stopPasses = observeConditionedPasses((pass, configurationRun) => {
    if (configurationRun) throw new Error(`the pass '${pass}' ran inside a configuration run`);
    union.set(pass, (union.get(pass) ?? 0) + 1);
  });
  const stopBranches = observePassBranches((pass, branch) => branches.set(pass, [...(branches.get(pass) ?? []), branch]));
  try {
    analyze();
  } finally {
    stopPasses();
    stopBranches();
  }
  return { union, branches };
}

describe("the passes that carry presence conditions", () => {
  it("run once over the union and never inside a configuration run: fixture S at N=4", async () => {
    const loaded = await loadGenerated("conditioned-pass-S-4.yaml", flagTargets(4));
    const runs: Array<[ConditionedPass, boolean]> = [];
    const stop = observeConditionedPasses((pass, configurationRun) => runs.push([pass, configurationRun]));
    let found: ReturnType<StaticAnalyzer["analyze"]>;
    try {
      found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    } finally {
      stop();
    }
    // The cycle through the two functions' choices is reported once.
    expect(
      found
        .filter((d) => d.code === "DEPENDENCY_CYCLE")
        .map((d) => (d.data as { configurations?: unknown }).configurations),
    ).toEqual([[{ "variables.flag1": true, "variables.flag2": true }]]);
    for (const pass of PASSES) {
      expect(runs.filter(([name]) => name === pass)).toEqual([[pass, false]]);
    }
    // The reference checks are judged per site and key, outside every run.
    const references = runs.filter(([name]) => name === "references");
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter(([, configurationRun]) => configurationRun)).toEqual([]);
  }, 120_000);

  it("are read once, plus once in each branch no configuration takes, however many configurations: fixture S at N=1, 4 and 8", async () => {
    const counts: string[] = [];
    for (const n of [1, 4, 8]) {
      const loaded = await loadGenerated(`conditioned-pass-reads-S-${n}.yaml`, flagTargets(n));
      const reads = passReads(() => new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments }));
      counts.push(JSON.stringify(PASSES.map((pass) => [pass, reads.union.get(pass) ?? 0, reads.branches.get(pass)?.length ?? 0])));
    }
    expect(new Set(counts).size).toBe(1);
    expect(JSON.parse(counts[0]!).every(([, union]: [string, number]) => union === 1)).toBe(true);
  }, 240_000);

  it("read each branch no configuration takes once, the branches every reading pass reads alike", async () => {
    const loaded = await loadFile(join(ROOT, "tests/__fixtures__/configurations/dead-branch.yaml"));
    const reads = passReads(() =>
      new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, positions: loaded.positions }),
    );
    const all = new Set([...reads.branches.values()].flat());
    expect(all.size).toBeGreaterThan(0);
    for (const [, branches] of reads.branches) {
      expect(branches.length).toBe(new Set(branches).size);
      expect(new Set(branches)).toEqual(all);
    }
    expect(reads.branches.get("throwsCoverage")?.length).toBe(all.size);
  }, 120_000);

  it("have tables no configuration, branch or witness reads back", () => {
    const tables = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => name === "union-passes.ts" || /\bPassTable\b/.test(readFileSync(join(SRC, name), "utf8")))
      .filter((name) => !["analyzer.ts", "union-placement.ts"].includes(name));
    expect(tables.length).toBeGreaterThan(10);
    const keyedByAssignment = /\bassignmentKey\(|Map<\s*Assignment\b|\bholdingAt\b|\binDeadBranch\b|\b(identityAt|relativePathAt|reportedAt)\(|render\(\s*witness\b|\bparityAt\b|\bwitnessDecider\(/g;
    const found = tables.flatMap((name) => (readFileSync(join(SRC, name), "utf8").match(keyedByAssignment) ?? []).map((m) => `${name}: ${m}`));
    expect(found).toEqual([]);
  });

  it("have a call graph no configuration reads back", () => {
    const graph = readFileSync(join(SRC, "conditioned-call-graph.ts"), "utf8");
    const atAssignment = /^ {2}(?:private |static )?\w+(?:<[^>]*>)?\([^)]*:\s*Assignment\b|\b\w*ParityAt\b|\bwitnessDecider\(/gm;
    expect(graph.match(atAssignment) ?? []).toEqual([]);
  });

  it("make a world only in the key enumeration and the dead-branch enumeration", () => {
    const sources = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));
    const makers = (pattern: RegExp) => sources.filter(({ text }) => pattern.test(text)).map(({ name }) => name);
    expect(makers(/\bWorld\.deadBranch\(/)).toEqual(["choice-reading.ts", "template-definition-check.ts"]);
    const keyEnumerations = [
      "analyzer.ts",
      "cel-site-solve.ts",
      "import-host-path-findings.ts",
      "lifted-body-findings.ts",
      "mark-reach-findings.ts",
      "need-table-findings.ts",
      "own-check-sites.ts",
      "resource-input-findings.ts",
      "rule-absence.ts",
      "scope-member-findings.ts",
      "text-findings.ts",
      "zone-region-findings.ts",
    ];
    expect(makers(/\bWorld\.key\(/)).toEqual(keyEnumerations);
    expect(makers(/\bnew World\(/)).toEqual(["conditioned-expansion.ts"]);
  });

  it("have a differential that selects pass findings by their family, never by a code, and leaves no family out", () => {
    const differential = readFileSync(join(SRC, "../tests/configuration-differential.test.ts"), "utf8");
    const selection = differential.split("\n").filter((line) => /^const (inPassOracle|inPresenceRead|inChoiceOracle)\b/.test(line));
    expect(selection.length).toBe(3);
    const text = selection.join("\n");
    expect(text.match(/"[A-Z]{2,}(?:_[A-Z0-9]+)+"/g) ?? []).toEqual([]);
    // A family is named only through a list held to an oracle of its own.
    expect(text.match(/"[a-z][A-Za-z]*"/g) ?? []).toEqual([]);
    expect([...new Set(text.match(/\b[A-Z_]+_FAMILIES\b/g))].sort()).toEqual(["CHOICE_FAMILIES", "PRESENCE_READ_FAMILIES"]);
    expect(differential).not.toMatch(/UNPORTED|UNION_PASS_CODES/);
  });

  it("define each pass family once", () => {
    const definers = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => /"duplicateNames"[\s\S]{0,40}"unusedDeclarations"/.test(readFileSync(join(SRC, name), "utf8")));
    expect(definers).toEqual(["analysis-families.ts"]);
  });
});
