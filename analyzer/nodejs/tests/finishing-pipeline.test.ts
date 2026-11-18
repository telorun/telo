import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { countViewSetEmissions, stopCountingViewSetEmissions } from "../src/cel-site-solve.js";
import { countFinishingSteps, stopCountingFinishingSteps } from "../src/finishing-pipeline.js";
import { flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("the finishing pipeline", () => {
  it("is fed by no site marker and no per-assignment read of a key's findings", () => {
    const gone = [
      "CEL_SITE_MARKER",
      "OWN_SITE_MARKER",
      "RELATION_SITE_MARKER",
      "verdictAt",
      "verdictInDeadBranch",
      "ownFindingsAt",
      "ownFindingsInDeadBranch",
      "relationFindingsAt",
      "relationFindingsInDeadBranch",
      "settledRules",
    ];
    const found = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return gone.filter((name) => new RegExp(`\\b${name}\\b`).test(text)).map((name) => `${file.slice(SRC.length + 1)}: ${name}`);
    });
    expect(found).toEqual([]);
  });

  it("is the only place findings are filtered and settled", () => {
    const gone = ["withoutRefusedFormConsequences", "withoutRefusedExpansionConsequences", "suppressUnreadableModuleDiagnostics"];
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const name = file.slice(SRC.length + 1);
      const text = readFileSync(file, "utf8");
      for (const each of gone) if (new RegExp(`\\b${each}\\b`).test(text)) found.push(`${name}: ${each}`);
      if (name !== "finishing-pipeline.ts" && /\bwithoutForwardedDuplicates\b/.test(text)) found.push(`${name}: withoutForwardedDuplicates`);
      // A rule verdict is settled by the pipeline alone; its reports define how.
      if (name === "finishing-pipeline.ts" || name === "resource-rule-relation.ts") continue;
      for (const call of text.match(/\.(settle|settleGroups|settleConditioned|unexercised)\(/g) ?? []) found.push(`${name}: ${call}`);
    }
    expect(found).toEqual([]);
  });

  it("places through one primitive, which the worlds construct", () => {
    const stages = /\b(relocatedRendering|rerootedQuotes|reportedAtHolder|relabelled)\(|\.(memberPlace|extractionPlace)\(/g;
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const name = file.slice(SRC.length + 1);
      if (["placement.ts", "quoted-place.ts", "rewrite-synthetic-origins.ts", "scope-members.ts"].includes(name)) continue;
      for (const call of readFileSync(file, "utf8").match(stages) ?? []) found.push(`${name}: ${call}`);
    }
    expect(found).toEqual([]);
    expect(sources(SRC).filter((file) => /\bclass Placement\b/.test(readFileSync(file, "utf8"))).map((file) => file.slice(SRC.length + 1))).toEqual([
      "placement.ts",
    ]);
  });

  it("moves a finding about a scope member or an extraction only through placement, the call graph supplying facts", () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const name = file.slice(SRC.length + 1);
      if (["placement.ts", "quoted-place.ts"].includes(name)) continue;
      if (/\breportedAtHolder\b/.test(readFileSync(file, "utf8"))) found.push(`${name}: reportedAtHolder`);
    }
    expect(found).toEqual([]);
    const graph = readFileSync(join(SRC, "conditioned-call-graph.ts"), "utf8");
    const imported = [...graph.matchAll(/from "\.\/([\w-]+)\.js"/g)].map((m) => m[1]);
    expect(imported.filter((module) => ["placement", "quoted-place", "union-placement", "scope-members"].includes(module!))).toEqual([]);
    expect(graph.match(/\b(locatedBy|syntheticOrigins|relabelled|rerootedQuotes|relocatedRendering)\b/g) ?? []).toEqual([]);
    // The graph's place facts are read by the union world's placement alone.
    const readers = sources(SRC)
      .filter((file) => /\breportedBy\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1));
    expect(readers.sort()).toEqual(["conditioned-call-graph.ts", "union-placement.ts"]);
  });

  it("decides no drop by the tag a key's finding was routed by", () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\b(celSite|relationGroup)\b/.test(line)) found.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
          if (/\bownGroup\b/.test(line) && /\bcontinue\b|\.filter\(|\breturn (true|false)\b/.test(line)) found.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });

  it("reads a view's no-place set where a finding is placed and where the CEL-site census defers, nowhere else", () => {
    const readers = sources(SRC).flatMap((file) => {
      const name = file.slice(SRC.length + 1);
      return (readFileSync(file, "utf8").match(/\.noPlace\.has\(/g) ?? []).map(() => name);
    });
    // The census walk's deferral; placement.
    expect(readers.sort()).toEqual(["analyzer.ts", "placement.ts"]);
    for (const file of sources(SRC)) {
      if (/\bbodyExpressionAt\b|\.expressions\.some\(\(at\)/.test(readFileSync(file, "utf8")) && !file.endsWith("conditioned-expansion.ts")) {
        throw new Error(`${file} tests whether a place holds a body expression`);
      }
    }
  });

  it("names a CEL site by one rule, which the census and the door import", () => {
    const defining = sources(SRC).filter((file) => /\bexport function celSiteName\b/.test(readFileSync(file, "utf8")));
    expect(defining.map((file) => file.slice(SRC.length + 1))).toEqual(["cel-site-name.ts"]);
    for (const name of ["cel-site-solve.ts", "analyzer.ts"]) {
      const text = readFileSync(join(SRC, name), "utf8");
      const imported = /import \{[^}]*\bcelSiteName\b[^}]*\} from "\.\/cel-site-name\.js"/.test(text);
      expect({ name, imported, named: /\bcelSiteName\(/.test(text), byHand: /\bcelSiteId\(/.test(text) }).toEqual({
        name,
        imported: true,
        named: true,
        byHand: false,
      });
    }
  });

  it("decides no CEL site, in the census or the door, by an expression object, an unmoved place or a moved option", () => {
    const bodyOf = (file: string, start: RegExp, end: RegExp): string[] => {
      const lines = readFileSync(join(SRC, file), "utf8").split("\n");
      const from = lines.findIndex((line) => start.test(line));
      expect([file, from >= 0]).toEqual([file, true]);
      const to = lines.findIndex((line, i) => i > from && end.test(line));
      return lines.slice(from, to + 1).map((line, i) => `${file}:${from + i + 1}: ${line}`);
    };
    const bodies = [
      ...bodyOf("cel-site-solve.ts", /^function unionSites\(/, /^\}$/),
      ...bodyOf("analyzer.ts", /^function placedSiteName\(/, /^\}$/),
      ...bodyOf("analyzer.ts", /^  private siteIdsOf\(/, /^  \}$/),
      ...bodyOf("analyzer.ts", /^  private judgeKeyIn\(/, /^  \}$/),
    ];
    const identity = /\.(has|get)\((value|expression|sentinel)\)|(===|!==)\s*(value|expression)\b|\b(value|expression)\s*(===|!==)(?!\s*(null\b|undefined\b|["'`]))|\b(Weak)?(Map|Set)<object/;
    const decided = /\b(if|while)\s*\(|\breturn\b|\bcontinue\b/;
    const unmovedOrMoved = /\bwritten\s*[!=]==\s*undefined|\.moved\b/;
    expect(bodies.filter((line) => identity.test(line) || (decided.test(line) && unmovedOrMoved.test(line)))).toEqual([]);
    // The door admits an occurrence by its name alone.
    expect(bodies.some((line) => /if \(siteOf\(m, e\.path\) !== request\.site\) return;/.test(line))).toBe(true);
  });

  it("emits each forward-view instance set's verdicts once per key class", async () => {
    let sets = 0;
    for (const fixture of ["forward-view-choice.yaml", "forward-view-origin.yaml", "template-body-choice.yaml"]) {
      const loaded = await loadFile(join(ROOT, "tests/__fixtures__/configurations", fixture));
      const counted = countViewSetEmissions();
      try {
        new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, positions: loaded.positions });
      } finally {
        stopCountingViewSetEmissions();
      }
      sets += counted.size;
      for (const [set, { emissions, keys }] of counted) expect([set, emissions]).toEqual([set, keys.size]);
    }
    expect(sets).toBeGreaterThan(0);
  });

  it("runs each step once per finding, however many configurations: fixture S at N=4 and N=8", async () => {
    const ratios: number[] = [];
    for (const n of [4, 8] as const) {
      const loaded = await loadGenerated(`finishing-S-${n}.yaml`, flagTargets(n));
      const counts = countFinishingSteps();
      try {
        new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, positions: loaded.positions });
      } finally {
        stopCountingFinishingSteps();
      }
      expect(counts.calls).toBe(1);
      for (const step of [counts.place, counts.cover, counts.settle, counts.forwarded, counts.merge]) {
        expect(step).toBeLessThanOrEqual(counts.inputs);
      }
      ratios.push(counts.cover / counts.inputs);
    }
    expect(ratios[0]).toBe(ratios[1]);
  }, 240_000);
});
