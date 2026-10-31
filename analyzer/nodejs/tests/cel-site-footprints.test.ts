import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { doorCare, invariantDeclarations } from "../src/key-door.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";
import {
  observeAnalysisRuns,
  observeCelSiteJudgements,
  observeIdentifierPasses,
  observeKeyCosts,
  type AnalysisRunPurpose,
  type CelSiteJudgement,
  type KeyCost,
} from "../src/cel-site-judgements.js";
import { ConditionedNameIndex } from "../src/conditioned-name-index.js";
import { KeyParts } from "../src/key-parts.js";
import { flagSequence, flagTargets, forwardedSequence, loadGenerated, RUN } from "./configuration-cost-fixtures.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** What the type checker makes of step k's result in configuration `flags`
 *  (1-based): text where its flag is off, the literal where the first is on,
 *  else what `steps.step<k-1>.result + 1` yields over the step before. */
function stepType(flags: readonly boolean[], k: number): "off" | "one" | "int" | "dyn" {
  if (!flags[k - 1]) return "off";
  if (k === 1) return "one";
  // A sum the checker refuses (text plus a number) is typed `dyn`, as one over
  // `dyn` is.
  return stepType(flags, k - 1) === "off" || stepType(flags, k - 1) === "dyn" ? "dyn" : "int";
}

/** The keys step k's expression has in fixture V of `n` flags: one per
 *  distinct class of the step it reads, over the configurations holding it. */
function expectedKeys(n: number, k: number): number {
  const classes = new Set<string>();
  for (let bits = 0; bits < 2 ** n; bits++) {
    const flags = Array.from({ length: n }, (_, i) => (bits & (1 << i)) !== 0);
    if (!flags[k - 1]) continue;
    classes.add(stepType(flags, k - 1));
  }
  return classes.size;
}

describe("CEL sites of fixture V", () => {
  for (const n of [2, 3, 4]) {
    it(`judges each step's expression once per key at N=${n}, none inside a configuration run`, async () => {
      const loaded = await loadGenerated(`flag-sequence-${n}.yaml`, flagSequence(n));
      const judgements: CelSiteJudgement[] = [];
      const stop = observeCelSiteJudgements((judgement) => judgements.push(judgement));
      try {
        new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      } finally {
        stop();
      }
      expect(judgements.filter((j) => j.configurationRun)).toEqual([]);
      const bySite = new Map<string, string[]>();
      for (const { site, key } of judgements) bySite.set(site!, [...(bySite.get(site!) ?? []), key!]);
      const counts: Record<string, number> = {};
      for (const [site, keys] of bySite) {
        expect(new Set(keys).size, site).toBe(keys.length);
        const [, name, , path] = JSON.parse(site) as [unknown, unknown, unknown, string];
        if (name === "sequence") counts[path] = keys.length;
      }
      const expected: Record<string, number> = {};
      for (let k = 2; k <= n; k++) expected[`steps[${k - 1}].value.then`] = expectedKeys(n, k);
      expect(counts).toEqual(expected);
      for (const count of Object.values(counts)) expect(count).toBeLessThanOrEqual(3);
    }, 120_000);
  }
});

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

async function loadFixture(name: string) {
  const file = join(SRC, "../../../tests/__fixtures__/configurations", name);
  const graph = await new Loader([fileSource]).loadGraph(file, { desugarImports: true });
  return { manifests: flattenForAnalyzer(graph), moduleDocuments: collectModuleDocuments(graph) };
}

describe("a key of a site absent at its witness", () => {
  const presencesOf = async (name: string, text: string) => {
    const loaded = await loadGenerated(name, text);
    const presences: Extract<KeyCost, { kind: "key-presence" }>[] = [];
    const stop = observeKeyCosts((cost) => {
      if (cost.kind === "key-presence") presences.push(cost);
    });
    try {
      new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    } finally {
      stop();
    }
    return presences;
  };
  it("reads no place beyond the site and covers nothing beyond its own region, in every key family", async () => {
    const presences = await presencesOf("flag-targets-2.yaml", flagTargets(2));
    const absent = presences.filter((p) => p.absent);
    expect(absent.some((p) => p.family === "schema")).toBe(true);
    for (const family of ["cel", "schema", "relation"] as const) {
      expect(presences.some((p) => p.family === family)).toBe(true);
    }
    expect(absent.filter((p) => p.reads !== 0 || p.covered !== 0)).toEqual([]);
  }, 120_000);
  it("does so where a forward view holds the sites", async () => {
    const presences = await presencesOf("forwarded-sequence-2.yaml", forwardedSequence(2));
    for (const family of ["cel", "schema", "relation"] as const) {
      expect(presences.some((p) => p.family === family)).toBe(true);
    }
    expect(presences.filter((p) => p.absent && (p.reads !== 0 || p.covered !== 0))).toEqual([]);
  }, 120_000);
});

describe("the analyses one analysis makes", () => {
  const cases: Array<[string, () => ReturnType<typeof loadFixture>]> = [
    ...[1, 2, 4].map((n): [string, () => ReturnType<typeof loadFixture>] => [
      `fixture V at N=${n}`,
      () => loadGenerated(`flag-sequence-${n}.yaml`, flagSequence(n)),
    ]),
    // A branch no configuration takes, and its own run.
    ["a dead branch", () => loadFixture("dead-branch.yaml")],
  ];
  for (const [label, load] of cases) {
    it(`builds one environment per key and no configuration's analysis to judge: ${label}`, async () => {
      const loaded = await load();
      const runs: AnalysisRunPurpose[] = [];
      const judgements: CelSiteJudgement[] = [];
      const identifierPasses: boolean[] = [];
      const stopRuns = observeAnalysisRuns((purpose) => runs.push(purpose));
      const stopJudgements = observeCelSiteJudgements((judgement) => judgements.push(judgement));
      const stopIdentifiers = observeIdentifierPasses((configurationRun) => identifierPasses.push(configurationRun));
      const analyzer = new StaticAnalyzer();
      try {
        analyzer.analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      } finally {
        stopRuns();
        stopJudgements();
        stopIdentifiers();
      }
      // Names are judged with a declaration's schema sites, never in a run.
      expect(identifierPasses.filter((inRun) => inRun)).toEqual([]);
      expect(identifierPasses.length).toBeGreaterThan(0);
      const { configurations, unreachable } = new StaticAnalyzer().configurationsOf(loaded.manifests, {
        moduleDocuments: loaded.moduleDocuments,
      });
      const count = (purpose: AnalysisRunPurpose) => runs.filter((run) => run === purpose).length;
      // One shared setup, one run per configuration and per branch no
      // configuration takes, and nothing else analyses a configuration.
      expect(count("setup")).toBe(1);
      expect(count("configuration")).toBe(configurations.length);
      expect(count("unreachable")).toBe(unreachable.length);
      expect(count("whole")).toBe(0);
      // One environment per key.
      const keys = new Set(judgements.map((j) => `${j.site}\0${j.key}`));
      expect(count("door")).toBe(keys.size);
    }, 120_000);
  }
});

/** What one analysis of `loaded` costs: every cost reported, and the keys. */
function costsOf(loaded: { manifests: Parameters<StaticAnalyzer["analyze"]>[0]; moduleDocuments: any }) {
  const costs: KeyCost[] = [];
  let doors = 0;
  const stopCosts = observeKeyCosts((cost) => costs.push(cost));
  const stopRuns = observeAnalysisRuns((purpose) => {
    if (purpose === "door") doors++;
  });
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stopCosts();
    stopRuns();
  }
  const normalizations = costs.flatMap((c) => (c.kind === "normalization" ? [c] : []));
  const environments = costs.flatMap((c) => (c.kind === "typed-environment" ? [c.content] : []));
  return { doors, normalizations, environments };
}

describe("what building the keys' environments costs", () => {
  it("normalizes a declaration no configuration varies once per outcome of its references, whatever the key count", async () => {
    const invariantAt: number[] = [];
    const keysAt: number[] = [];
    for (const n of [1, 2, 3]) {
      const { doors, normalizations } = costsOf(await loadGenerated(`flag-sequence-${n}.yaml`, flagSequence(n)));
      const invariant = normalizations.filter((c) => c.invariant);
      const pairs = new Map<object, Set<string>>();
      for (const c of invariant) pairs.set(c.declaration, (pairs.get(c.declaration) ?? new Set()).add(c.outcomes));
      // Never twice for one declaration and one outcome of each reference.
      expect(invariant.length).toBe([...pairs.values()].reduce((sum, outcomes) => sum + outcomes.size, 0));
      invariantAt.push(invariant.length);
      keysAt.push(doors);
    }
    // The same declarations at every N, while the keys grow.
    expect(new Set(invariantAt).size).toBe(1);
    expect(keysAt[2]).toBeGreaterThan(keysAt[0]!);
  }, 120_000);

  it("adds one normalization and no typed environment per padding declaration", async () => {
    const plain = costsOf(await loadGenerated("flag-sequence-2.yaml", flagSequence(2)));
    const padded = costsOf(await loadGenerated("flag-sequence-2-padded.yaml", flagSequence(2, 40)));
    expect(padded.doors - plain.doors).toBe(40);
    expect(padded.normalizations.length - plain.normalizations.length).toBe(40);
    // Forty keys whose expressions read nothing type in one environment.
    expect(padded.environments.length - plain.environments.length).toBeLessThanOrEqual(1);
  }, 120_000);

  const environmentCases: Array<[string, () => ReturnType<typeof loadGenerated>]> = [
    ...[1, 2, 3].map((n): [string, () => ReturnType<typeof loadGenerated>] => [
      `fixture V at N=${n}`,
      () => loadGenerated(`flag-sequence-${n}.yaml`, flagSequence(n)),
    ]),
    ["fixture S at N=2", () => loadGenerated("flag-targets-2.yaml", flagTargets(2))],
  ];
  for (const [label, load] of environmentCases) {
    it(`builds one typed environment per distinct content, at most one per key: ${label}`, async () => {
      const { doors, environments } = costsOf(await load());
      expect(new Set(environments).size).toBe(environments.length);
      expect(environments.length).toBeLessThanOrEqual(doors);
    }, 120_000);
  }

  it("gives two keys whose projections are equal the same normalized objects", async () => {
    const loaded = await loadGenerated(
      "equal-projections.yaml",
      `kind: Telo.Application
metadata: { name: EqualProjections }
imports:
  Run: ${join(SRC, "../../../modules/run")}
variables:
  flag1: { env: FLAG_1, type: boolean, default: false }
  flag2: { env: FLAG_2, type: boolean, default: false }
---
kind: Run.Value
metadata: { name: a }
value: !if
  if: !cel "variables.flag1"
  then: 1
  else: 2
---
kind: Run.Value
metadata: { name: b }
value: !cel "'b'"
---
kind: Run.Value
metadata: { name: c }
value: !if
  if: !cel "variables.flag2"
  then: 3
  else: 4
`,
    );
    const options = { moduleDocuments: loaded.moduleDocuments };
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(loaded.manifests, options, registry);
    const { union, configurations } = new StaticAnalyzer().configurationsOf(loaded.manifests, options);
    const ctx = registry._context();
    const care = doorCare(union, union.space.some(configurations.map((c) => union.space.assignment(c))));
    const parts = new KeyParts({
      union,
      names: new ConditionedNameIndex(union),
      careAt: () => care,
      defs: ctx.definitions!,
      aliases: ctx.aliases!,
      aliasesByModule: ctx.aliasesByModule ?? new Map(),
      templates: undefined,
    });
    const named = (name: string) => union.declarations.find((d) => d.manifest.metadata?.name === name)!;
    const at = (flag1: boolean, flag2: boolean) => ({
      assignment: configurations.find((c) => {
        const value = (flag: string) => Object.entries(c).find(([key]) => key.endsWith(flag))?.[1];
        return value("flag1") === flag1 && value("flag2") === flag2;
      })!,
    });
    expect(configurations).toHaveLength(4);
    // `a` reads flag1 alone: equal wherever flag1 is.
    expect(parts.partAt(named("a"), at(true, false), 0)).toBe(parts.partAt(named("a"), at(true, true), 0));
    expect(parts.partAt(named("a"), at(false, false), 0)).not.toBe(parts.partAt(named("a"), at(true, false), 0));
    // `b` holds no choice: one part, the same at every witness.
    const b = parts.partAt(named("b"), at(false, false), 0);
    expect(b.fixed).toBe(true);
    for (const [x, y] of [[false, true], [true, false], [true, true]] as const) {
      expect(parts.partAt(named("b"), at(x, y), 0)).toBe(b);
    }
  }, 120_000);
});

const SHAPES = `kind: Telo.Application
metadata:
  name: ShapeRegistry
variables:
  flag1: { env: FLAG_1, type: boolean, default: false }
---
kind: Telo.JsonSchema
metadata:
  name: Plain
schema:
  type: object
  properties:
    y: { type: string }
---
kind: Telo.JsonSchema
metadata:
  name: Result
schema:
  type: object
  properties:
    x: !if
      if: !cel "variables.flag1"
      then: { type: integer }
---
kind: Telo.JsonSchema
metadata:
  name: Child
extends: Result
schema:
  type: object
---
kind: Telo.Definition
metadata:
  name: Op
capability: Telo.Runnable
schema:
  type: object
  properties:
    plain: { $ref: "telo://Self/Plain" }
    result: { $ref: "telo://Self/Child" }
---
kind: Self.Op
metadata:
  name: op
plain: { y: a }
result: { x: 1 }
`;

describe("the shared registry", () => {
  it("holds only the named shapes no configuration varies, and none another run registered", async () => {
    const loaded = await loadGenerated("shape-registry.yaml", SHAPES);
    const options = { moduleDocuments: loaded.moduleDocuments };
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(loaded.manifests, options, registry);
    const shared = [...registry._context().definitions!.sharedNamedShapeIds()].filter((id) =>
      id.startsWith("telo:ShapeRegistry/"),
    );
    const { union } = new StaticAnalyzer().configurationsOf(loaded.manifests, options);
    const invariant = new Set(
      [...invariantDeclarations(union)].map((d) => `telo:ShapeRegistry/${String(d.manifest.metadata?.name)}`),
    );
    for (const id of shared) expect(invariant.has(id), id).toBe(true);
    // `Child` is declared everywhere alike, but folds a parent a choice varies.
    expect(shared).toEqual(["telo:ShapeRegistry/Plain"]);
  }, 120_000);
});

const MEMBER_TARGET = `kind: Telo.Application
metadata:
  name: MemberTarget
imports:
  Run: ${RUN}
variables:
  flag1: { env: FLAG_1, type: boolean, default: false }
targets:
  - !ref main
---
kind: Run.Sequence
metadata: { name: main }
with:
  - kind: Run.Value
    metadata: { name: target }
    outputType:
      kind: Telo.JsonSchema
      schema:
        type: object
        additionalProperties: false
        properties:
          x: { type: integer }
          y: !if
            if: !cel "variables.flag1"
            then: { type: integer }
    value: { x: 1 }
steps:
  - name: call
    invoke: !ref target
  - name: read
    value: !cel "steps.call.result.y"
`;

describe("a step invoking a member of its own scope", () => {
  it("is typed from the member as each configuration declares it", async () => {
    const loaded = await loadGenerated("member-target.yaml", MEMBER_TARGET);
    const found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    expect(found.map((d) => [d.code, (d.data as { path?: string }).path, d.message])).toEqual([
      [
        "CEL_UNKNOWN_FIELD",
        "steps[1].value",
        "Run.Sequence/main: !cel: 'steps.call.result.y' is not defined (available: x) (when variables.flag1 is false)",
      ],
    ]);
  }, 120_000);
});

const CALL_SLOT = `
kind: Telo.Application
metadata:
  name: CallSlot
variables:
  flag1: { env: FLAG_1, type: boolean, default: false }
targets:
  - !ref op
---
kind: Telo.Function
metadata:
  name: pick
params: []
returns: !if
  if: !cel "variables.flag1"
  then: { schema: { type: integer } }
  else: { schema: { type: string } }
body: !cel "dyn(1)"
---
kind: Telo.Definition
metadata:
  name: Op
capability: Telo.Runnable
schema:
  type: object
  properties:
    payload: { type: integer, x-telo-eval: compile }
---
kind: Self.Op
metadata:
  name: op
payload: !cel "Self.pick()"
`;

describe("a value held to its slot", () => {
  it("is judged by what its expression was typed as in each configuration", async () => {
    const loaded = await loadGenerated("call-slot.yaml", CALL_SLOT);
    const found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    expect(found.map((d) => [d.code, (d.data as { path?: string }).path, d.message])).toEqual([
      [
        "CEL_TYPE_ERROR",
        "payload",
        "Self.Op/op: CEL at 'payload' returns 'string' but the field expects 'integer'. (when variables.flag1 is false)",
      ],
    ]);
  }, 120_000);
});

describe("the per-site model's boundary", () => {
  it("is the only reader of the union and its conditions: no check depends on them", () => {
    const readers = readdirSync(SRC)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => /from "\.\/(presence-condition|conditioned-expansion)\.js"/.test(readFileSync(join(SRC, file), "utf8")))
      .sort();
    expect(readers).toEqual([
      // The driver: one analysis, its configurations and the site solution.
      "analyzer.ts",
      // The site model and the witness loop.
      "cel-site-solve.ts",
      // The reading of choices, which produces each branch's condition.
      "choice-reading.ts",
      "conditioned-expansion.ts",
      // Name resolution's outcomes, each under its condition.
      "conditioned-name-index.ts",
      // Labels: the one cover.
      "configuration-dimensions.ts",
      "configuration-merge.ts",
      "index.ts",
      // The door: what one key's environment answers, read off the union.
      "key-door.ts",
      // What a key's environment is built from: each declaration normalized
      // at the key's witness, interned.
      "key-parts.ts",
      // Where a declaration's own checks are cut into sites.
      "own-check-sites.ts",
      // Where a region of a declaration stands at a witness: what a relation
      // site's key is normalized in.
      "region-part.ts",
      // A consumer's expansion of a template body, lifted over every
      // configuration for the forward views.
      "template-consumer-expansion.ts",
      // Its variant labels through the cover; converted in card 3c-7.
      "template-definition-check.ts",
      // The one body expansion, lifted for the forward views.
      "template-expansion.ts",
      // The one forward-view builder, lifted over the union.
      "template-forward.ts",
      // The whole-application passes that carry conditions, each run once over
      // the union.
      "union-passes.ts",
    ]);
  });

  it("refuses to compile a judge whose input holds a manifest list", () => {
    const file = join(SRC, "cel-judge.ts");
    const written = readFileSync(file, "utf8");
    const marker = "export interface CelJudgeWorld {\n";
    expect(written).toContain(marker);
    const compile = (source: string) => {
      const host = ts.createCompilerHost({});
      const read = host.readFile;
      host.readFile = (name) => (resolve(name) === resolve(file) ? source : read(name));
      const program = ts.createProgram({
        rootNames: [file],
        options: {
          noEmit: true,
          strict: true,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          target: ts.ScriptTarget.ES2022,
          skipLibCheck: true,
          customConditions: ["source"],
        },
        host,
      });
      return ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.file !== undefined && resolve(d.file.fileName) === resolve(file))
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    };
    expect(compile(written)).toEqual([]);
    const widened = written.replace(marker, `${marker}  readonly manifests: readonly ResourceManifest[];\n`);
    expect(compile(widened).some((m) => m.includes("holdsNoManifestList") || m.includes("'true' is not assignable"))).toBe(true);
  }, 120_000);

  it("refuses to compile a read table missing an annotation", () => {
    const file = join(SRC, "__read-table-probe.ts");
    const source = [
      'import { ANNOTATION_READS, type AnnotationReadTable } from "./annotation-reads.js";',
      'const partial: Omit<AnnotationReadTable, "x-telo-match-for"> = ANNOTATION_READS;',
      "export const table: AnnotationReadTable = partial;",
    ].join("\n");
    const host = ts.createCompilerHost({});
    const read = host.readFile;
    host.readFile = (name) => (resolve(name) === resolve(file) ? source : read(name));
    const exists = host.fileExists;
    host.fileExists = (name) => resolve(name) === resolve(file) || exists(name);
    const program = ts.createProgram({
      rootNames: [file],
      options: {
        noEmit: true,
        strict: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        skipLibCheck: true,
      },
      host,
    });
    const messages = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file !== undefined && resolve(d.file.fileName) === resolve(file))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(messages.some((m) => m.includes("x-telo-match-for"))).toBe(true);
  }, 120_000);
});
