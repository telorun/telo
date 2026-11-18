import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeRelationStages, observeDocumentStages } from "../src/cel-site-judgements.js";
import type { ResourceManifest } from "@telorun/sdk";
import { AliasResolver } from "../src/alias-resolver.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { kindContextNames } from "../src/kind-context-names.js";
import { NamedShapeReader, observeShapeVerdicts } from "../src/named-shape-reader.js";
import { ConditionSpace, TRUE } from "../src/presence-condition.js";
import { loadGenerated } from "./configuration-cost-fixtures.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/__fixtures__/configurations");

/** Every sub-verdict a named-shape reader computes while `analyze` runs. */
function shapeVerdicts(analyze: () => void): string[] {
  const seen: string[] = [];
  const stop = observeShapeVerdicts((kind, id, index) => seen.push(JSON.stringify([kind, id, index])));
  try {
    analyze();
  } finally {
    stop();
  }
  return seen;
}

function flags(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `  flag${i + 1}: { env: FLAG_${i + 1}, type: boolean, default: false }`);
}

/** A kind reaching a chain of `k` shapes, each varying under a choice of its own;
 *  the last one's varying branch points at a local definition it lacks. */
function shapeChain(k: number, kinds = 1): string {
  const lines = ["kind: Telo.Application", "metadata: { name: ShapeChain }", "variables:", ...flags(k)];
  for (let i = 1; i <= k; i++) {
    const then = i === k ? `{ type: object, properties: { a: { $ref: "#/$defs/missing" } } }` : `{ type: object, properties: { next: { $ref: "telo://Self/S${i + 1}" } } }`;
    lines.push("---", "kind: Telo.JsonSchema", `metadata: { name: S${i} }`, "schema: !if", `  if: !cel "variables.flag${i}"`, `  then: ${then}`, "  else: { type: object }");
  }
  for (let j = 1; j <= kinds; j++) {
    lines.push(
      "---",
      "kind: Telo.Definition",
      `metadata: { name: Holder${j} }`,
      "capability: Telo.Provider",
      `controllers: [pkg:telo/local/js?path=./probe.mjs#Holder${j}]`,
      "schema:",
      "  type: object",
      `  properties: { first: { $ref: "telo://Self/S1" } }`,
    );
  }
  return lines.join("\n") + "\n";
}

/** `kinds` kinds whose accessor field reaches a chain of `k` shapes, each
 *  varying under a choice of its own; the last one's varying branch is a text. */
function annotationChain(k: number, kinds: number): string {
  const lines = ["kind: Telo.Application", "metadata: { name: AnnotationChain }", "variables:", ...flags(k)];
  for (let i = 1; i <= k; i++) {
    const then = i === k ? `{ $ref: "telo://manifest#/$defs/Text" }` : `{ $ref: "telo://Self/S${i + 1}" }`;
    lines.push(
      "---",
      "kind: Telo.JsonSchema",
      `metadata: { name: S${i} }`,
      "schema:",
      "  type: object",
      "  properties:",
      "    next: !if",
      `      if: !cel "variables.flag${i}"`,
      `      then: ${then}`,
      "      else: { type: string }",
    );
  }
  for (let j = 1; j <= kinds; j++) {
    lines.push(
      "---",
      "kind: Telo.Definition",
      `metadata: { name: Holder${j} }`,
      "capability: Telo.Provider",
      `controllers: [pkg:telo/local/js?path=./probe.mjs#Holder${j}]`,
      "schema:",
      "  type: object",
      `  properties: { first: { $ref: "telo://Self/S1", x-telo-eval: accessor, x-telo-context: { type: object, properties: { row: {} } } } }`,
    );
  }
  return lines.join("\n") + "\n";
}

/** `n` kinds, each naming by its contract and its schema a shape declared only
 *  under a choice of its own. */
function shapeReferences(n: number): string {
  const lines = ["kind: Telo.Application", "metadata: { name: ShapeReferences }", "variables:", ...flags(n)];
  for (let i = 1; i <= n; i++) {
    lines.push(
      "---",
      "!if",
      `metadata: { name: Payload${i} }`,
      `if: !cel "variables.flag${i}"`,
      "then: { kind: Telo.JsonSchema, schema: { type: object } }",
      "---",
      "kind: Telo.Definition",
      `metadata: { name: Handler${i} }`,
      "capability: Telo.Invocable",
      `controllers: [pkg:telo/local/js?path=./probe.mjs#Handler${i}]`,
      `inputType: Payload${i}`,
      `schema: { type: object, properties: { payload: { $ref: "telo://Self/Payload${i}" } } }`,
    );
  }
  return lines.join("\n") + "\n";
}

describe("the named-shape reader", () => {
  it("compiles each class of each shape a kind reaches once, and reports one finding per failing pair under its own condition", async () => {
    const text = readFileSync(resolve(FIXTURES, "shape-compile-two-choices.yaml"), "utf8");
    const loaded = await loadGenerated("shape-compile-two-choices.yaml", text);
    let found: ReturnType<StaticAnalyzer["analyze"]> = [];
    const verdicts = shapeVerdicts(() => {
      found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    });
    const compiled = verdicts.filter((v) => JSON.parse(v)[0] === "compile");
    expect(new Set(compiled).size).toBe(compiled.length);
    // Two classes of each of the two shapes.
    expect(compiled).toHaveLength(4);
    const compileErrors = found.filter((d) => d.code === "SCHEMA_COMPILE_ERROR");
    expect(compileErrors.map((d) => (d.data as { configurations?: unknown }).configurations)).toEqual(
      expect.arrayContaining([[{ "variables.flag1": true }], [{ "variables.flag2": true }]]),
    );
    expect(compileErrors).toHaveLength(2);
  }, 120_000);

  it("compiles a chain of k varying shapes in a count linear in k, once per class however many kinds reach it, in no run: k=1, 4 and 8", async () => {
    const counts: number[] = [];
    for (const k of [1, 4, 8]) {
      const loaded = await loadGenerated(`shape-chain-${k}.yaml`, shapeChain(k, 2));
      const inRuns: string[] = [];
      const stop = observeDocumentStages((stage, configurationRun) => {
        if (stage === "schemaCompile" && configurationRun) inRuns.push(stage);
      });
      let compiled: string[] = [];
      try {
        compiled = shapeVerdicts(() =>
          new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments }),
        ).filter((v) => JSON.parse(v)[0] === "compile");
      } finally {
        stop();
      }
      expect(inRuns).toEqual([]);
      expect(new Set(compiled).size).toBe(compiled.length);
      counts.push(compiled.length);
    }
    expect(counts).toEqual([2, 8, 16]);
  }, 240_000);

  it("walks a chain of k varying shapes an annotation reaches in a count linear in k, once per class however many kinds reach it, in no run: k=1, 4 and 8", async () => {
    const counts: number[] = [];
    for (const k of [1, 4, 8]) {
      const loaded = await loadGenerated(`annotation-chain-${k}.yaml`, annotationChain(k, 2));
      const inRuns: string[] = [];
      const evaluated: string[] = [];
      const stop = observeDocumentStages((stage, configurationRun) => {
        if (stage !== "kindAnnotations") return;
        evaluated.push(stage);
        if (configurationRun) inRuns.push(stage);
      });
      let walked: string[] = [];
      let found: ReturnType<StaticAnalyzer["analyze"]> = [];
      try {
        walked = shapeVerdicts(() => {
          found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
        }).filter((v) => /^(textBeneath|textValues|pathParamsAnnotations)/.test(JSON.parse(v)[0]));
      } finally {
        stop();
      }
      expect(inRuns).toEqual([]);
      expect(evaluated).toHaveLength(1);
      expect(new Set(walked).size).toBe(walked.length);
      counts.push(walked.length);
      const refused = found.filter((d) => d.code === "TEXT_SLOT_ACCESSOR");
      expect(refused).toHaveLength(2);
      const all = Object.fromEntries(Array.from({ length: k }, (_, i) => [`variables.flag${i + 1}`, true]));
      for (const d of refused) {
        expect(d.message).toContain("through the named shape 'S1'");
        expect((d.data as { configurations?: unknown }).configurations).toEqual([all]);
      }
    }
    // Each class of each shape, walked once by each of the three walks.
    expect(counts).toEqual([6, 24, 48]);
  }, 240_000);

  it("judges each named-shape reference once per relation key, in no run: N=1, 4 and 8 — linear in the choices", async () => {
    const totals: number[] = [];
    for (const n of [1, 4, 8]) {
      const loaded = await loadGenerated(`shape-references-${n}.yaml`, shapeReferences(n));
      let count = 0;
      const inRuns: string[] = [];
      const stop = observeRelationStages((stage, configurationRun) => {
        if (stage !== "namedShapeReferences") return;
        count++;
        if (configurationRun) inRuns.push(stage);
      });
      let found: ReturnType<StaticAnalyzer["analyze"]> = [];
      try {
        found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      } finally {
        stop();
      }
      expect(inRuns).toEqual([]);
      expect(found.filter((d) => d.code === "CONTRACT_TYPE_NOT_FOUND")).toHaveLength(n);
      expect(found.filter((d) => d.code === "SCHEMA_TYPE_REF_UNRESOLVED")).toHaveLength(n);
      totals.push(count);
    }
    expect((totals[2]! - totals[1]!) / 4).toBe((totals[1]! - totals[0]!) / 3);
  }, 240_000);

  it("names each binding a kind's contexts declare where it holds: its own everywhere, a varying shape's under that shape's class", () => {
    const space = new ConditionSpace([{ key: "variables.flag1", values: [false, true] }]);
    const on = space.literal("variables.flag1", [true]);
    const context = (name: string) => ({ "x-telo-eval": "runtime", "x-telo-context": { type: "object", properties: { [name]: {} } } });
    const declaration = (condition: typeof on, schema: Record<string, unknown>) => {
      const manifest = { kind: "Telo.JsonSchema", metadata: { name: "Row", module: "app" }, schema } as unknown as ResourceManifest;
      return { manifest, condition, project: () => manifest };
    };
    const aliases = new AliasResolver();
    const reader = new NamedShapeReader({
      space,
      universe: TRUE,
      declarations: [
        declaration(on, { type: "object", properties: { cell: context("row") } }),
        declaration(space.not(on), { type: "object", properties: { cell: { type: "string" } } }),
      ],
      scope: { defs: new DefinitionRegistry(), aliases, aliasesByModule: new Map([["app", aliases]]), rootModules: new Set(["app"]) },
      libraries: [],
    });
    const kind = { type: "object", properties: { own: context("item"), shaped: { $ref: "telo:app/Row" } } };
    const names = kindContextNames(kind, reader, () => undefined);
    expect(names).toEqual(expect.arrayContaining([{ name: "item", condition: TRUE }, { name: "row", condition: on }]));
    expect(names).toHaveLength(2);
  });

  it("computes each class's context names once, however many kinds reach it, each held where its class is reached: N=1, 4 and 8", () => {
    const context = (name: string) => ({ "x-telo-eval": "runtime", "x-telo-context": { type: "object", properties: { [name]: {} } } });
    const counts: number[] = [];
    for (const n of [1, 4, 8]) {
      const space = new ConditionSpace(Array.from({ length: n }, (_, i) => ({ key: `variables.flag${i + 1}`, values: [false, true] })));
      const on = (i: number) => space.literal(`variables.flag${i}`, [true]);
      // S<i> holds `row<i>` and, where flag<i> holds, a reference on to S<i+1>:
      // S<i+1>'s names are reached only through it.
      const declarations = Array.from({ length: n }, (_, k) => {
        const i = k + 1;
        const own = { cell: context(`row${i}`) };
        const shape = (schema: Record<string, unknown>, condition: ReturnType<typeof on>) => {
          const manifest = { kind: "Telo.JsonSchema", metadata: { name: `S${i}`, module: "app" }, schema } as unknown as ResourceManifest;
          return { manifest, condition, project: () => manifest };
        };
        const next = i < n ? { next: { $ref: `telo:app/S${i + 1}` } } : {};
        return [
          shape({ type: "object", properties: { ...own, ...next } }, on(i)),
          shape({ type: "object", properties: { ...own, other: { type: "string" } } }, space.not(on(i))),
        ];
      }).flat();
      const aliases = new AliasResolver();
      const reader = new NamedShapeReader({
        space,
        universe: TRUE,
        declarations,
        scope: { defs: new DefinitionRegistry(), aliases, aliasesByModule: new Map([["app", aliases]]), rootModules: new Set(["app"]) },
        libraries: [],
      });
      const kind = { type: "object", properties: { own: context("item"), shaped: { $ref: "telo:app/S1" } } };
      const computed: string[] = [];
      const stop = observeShapeVerdicts((verdict, id, index) => {
        if (verdict.startsWith("contextNames")) computed.push(JSON.stringify([verdict, id, index]));
      });
      let first: ReturnType<typeof kindContextNames> = [];
      try {
        first = kindContextNames(kind, reader, () => undefined);
        expect(kindContextNames(kind, reader, () => undefined)).toEqual(first);
      } finally {
        stop();
      }
      expect(new Set(computed).size).toBe(computed.length);
      counts.push(computed.length);
      const held = new Map(first.map(({ name, condition }) => [name, condition]));
      expect(held.get("item")).toBe(TRUE);
      expect(held.get("row1")).toBe(TRUE);
      for (let i = 2; i <= n; i++) {
        expect(held.get(`row${i}`)).toBe(space.every(Array.from({ length: i - 1 }, (_, k) => on(k + 1))));
      }
    }
    // Each class of each shape, once.
    expect(counts).toEqual([2, 8, 16]);
  });

  it("stands in for a shape with a document holding each pointer named into it, lists where the pointer indexes one", () => {
    const aliases = new AliasResolver();
    const reader = new NamedShapeReader({
      space: new ConditionSpace([]),
      universe: TRUE,
      declarations: [],
      scope: { defs: new DefinitionRegistry(), aliases, aliasesByModule: new Map(), rootModules: new Set(["app"]) },
      libraries: [],
    });
    const ref = "telo:app/Address#/anyOf/1/properties/queryParams";
    const standIns = reader.standIns([[{ ref, target: "telo:app/Address", pointer: "#/anyOf/1/properties/queryParams" }]]);
    expect(standIns.get("telo:app/Address")).toEqual({ anyOf: [{}, { properties: { queryParams: {} } }] });
  });
});
