import { describe, expect, it } from "vitest";
import type { ResourceDefinition } from "@telorun/sdk";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeDocumentStages } from "../src/cel-site-judgements.js";
import { observeShapeVerdicts } from "../src/named-shape-reader.js";
import { observeEvalModeBranchRenders } from "../src/eval-mode-branch-findings.js";
import { loadGenerated } from "./configuration-cost-fixtures.js";
import { outputToProblems, type OutputToReads } from "../src/output-to-slot.js";
import { shapeValueSchemaFromProblems, valueSchemaFromProblems } from "../src/validate-value-schema-location.js";

/** The two kind-document verdicts that may read a named shape: what each reads
 *  of a shape is a reading's answer, held where the reading says. */

describe("outputTo of a kind", () => {
  const definition = { kind: "Telo.Definition", metadata: { name: "Holder" } } as unknown as ResourceDefinition;
  const schema = {
    type: "object",
    properties: {
      source: { "x-telo-ref": { kind: "Source", use: "call", outputTo: { slot: "/target", member: "body" } } },
      target: { "x-telo-ref": { kind: "Target", use: "call" } },
    },
  };
  const resolve = () => ({ kind: "Telo.Definition", metadata: { name: "Target" } }) as unknown as ResourceDefinition;

  it("holds each refusal where the reading of the contract it read holds", () => {
    const contract = { $ref: "telo:Lib/Input" };
    const reads: OutputToReads<string> = {
      everywhere: "all",
      follow: (node, document, segments, at) => {
        if (node !== contract) {
          let at2: Record<string, any> | undefined = node;
          for (const segment of segments) at2 = at2?.properties?.[segment];
          return [{ node: at2, held: at }];
        }
        return [
          { node: { type: "object", properties: { body: {} } }, held: `${at}&flag` },
          { node: { type: "object", properties: {} }, held: `${at}&!flag` },
        ];
      },
      inputContract: () => contract,
    };
    const problems = outputToProblems(definition, schema, resolve, reads);
    expect(problems.map((p) => p.held)).toEqual(["all&!flag"]);
    expect(problems[0]!.message).toContain("declares no member 'body'");
  });
});

describe("x-telo-value-schema-from of a kind", () => {
  const definition = {
    metadata: { name: "Holder" },
    schema: { type: "object", properties: { type: {}, own: { "x-telo-value-schema-from": "/missing" } } },
    inputType: { $ref: "telo:Lib/Input" },
  };
  const effective = { type: "object", properties: { type: {} } };
  const shape = { name: "Input", schema: { type: "object", properties: { x: { "x-telo-value-schema-from": "/absent" } } } };

  it("judges the kind's own fields alone, and a named shape's annotations at the field naming it", () => {
    expect(valueSchemaFromProblems(definition, effective).map((p) => p.path)).toEqual(["schema.properties.own.x-telo-value-schema-from"]);
    expect(shapeValueSchemaFromProblems("Holder", "inputType", shape, effective).map((p) => p.path)).toEqual(["inputType"]);
    expect(valueSchemaFromProblems(definition, effective, (field) => (field ? shape : undefined)).map((p) => p.path)).toEqual([
      "schema.properties.own.x-telo-value-schema-from",
      "inputType",
    ]);
  });
});

/** `n` verifier kinds, each with an input contract naming a shape of its own
 *  that declares the `presentation` member — and a value-schema-from location
 *  its kind lacks — only where a choice of its own holds; one holder per
 *  verifier hands a source's output to it as that member. */
function shapeVerdicts(n: number): string {
  const lines = ["kind: Telo.Application", "metadata: { name: ShapeVerdicts }", "variables:"];
  for (let i = 1; i <= n; i++) lines.push(`  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`);
  lines.push(
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Source }",
    "capability: Telo.Invocable",
    "controllers: [pkg:telo/local/js?path=./probe.mjs#Source]",
    "schema: { type: object }",
  );
  for (let i = 1; i <= n; i++) {
    lines.push(
      "---",
      "kind: Telo.JsonSchema",
      `metadata: { name: P${i} }`,
      "schema: !if",
      `  if: !cel "variables.flag${i}"`,
      "  then: { type: object, properties: { presentation: { type: string }, value: { x-telo-value-schema-from: /absent } } }",
      "  else: { type: object, properties: { other: { type: string } } }",
      "---",
      "kind: Telo.Definition",
      `metadata: { name: Verifier${i} }`,
      "capability: Telo.Invocable",
      `controllers: [pkg:telo/local/js?path=./probe.mjs#Verifier${i}]`,
      `inputType: !ref P${i}`,
      "schema: { type: object }",
      "---",
      "kind: Telo.Definition",
      `metadata: { name: Holder${i} }`,
      "capability: Telo.Service",
      `controllers: [pkg:telo/local/js?path=./probe.mjs#Holder${i}]`,
      "schema:",
      "  type: object",
      "  properties:",
      "    source: { x-telo-ref: { kind: Self.Source, use: call, outputTo: { slot: /verifier, member: presentation } } }",
      `    verifier: { x-telo-ref: { kind: Self.Verifier${i}, use: call } }`,
    );
  }
  return lines.join("\n") + "\n";
}

describe("the kind verdicts reading a varying named shape", () => {
  it("are judged in the kind documents' stage alone, each shape class read once, never in a run: N=1, 4 and 8", async () => {
    const counts: number[] = [];
    for (const n of [1, 4, 8]) {
      const loaded = await loadGenerated(`kind-shape-verdicts-${n}.yaml`, shapeVerdicts(n));
      const stages: { stage: string; inRun: boolean }[] = [];
      const read: string[] = [];
      const stopStages = observeDocumentStages((stage, inRun) => {
        if (stage === "kindAnnotations" || stage === "kindSlotAnnotations" || stage === "kindRefSlots") stages.push({ stage, inRun });
      });
      const stopShapes = observeShapeVerdicts((verdict, id, index) => {
        if (/^(pathStep|valueSchemaAnnotations)/.test(verdict)) read.push(JSON.stringify([verdict, id, index]));
      });
      let found: ReturnType<StaticAnalyzer["analyze"]> = [];
      try {
        found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      } finally {
        stopStages();
        stopShapes();
      }
      expect(stages.filter((s) => s.inRun)).toEqual([]);
      for (const stage of ["kindAnnotations", "kindSlotAnnotations", "kindRefSlots"]) {
        expect(stages.filter((s) => s.stage === stage), stage).toHaveLength(1);
      }
      expect(new Set(read).size).toBe(read.length);
      counts.push(read.length);
      const outputTo = found.filter((d) => d.code === "X_TELO_REF_INVALID_OUTPUT_TO");
      const location = found.filter((d) => d.code === "VALUE_SCHEMA_FROM_INVALID");
      expect(outputTo).toHaveLength(n);
      expect(location).toHaveLength(n);
      for (let i = 1; i <= n; i++) {
        const configurations = (name: string, code: string) =>
          (found.find((d) => d.code === code && (d.data as { resource?: { name?: string } }).resource?.name === name)?.data as { configurations?: unknown })
            ?.configurations;
        expect(configurations(`Holder${i}`, "X_TELO_REF_INVALID_OUTPUT_TO")).toEqual([{ [`variables.flag${i}`]: false }]);
        expect(configurations(`Verifier${i}`, "VALUE_SCHEMA_FROM_INVALID")).toEqual([{ [`variables.flag${i}`]: true }]);
      }
    }
    // Each class of each shape: its member lookup and its annotations, once.
    expect(counts).toEqual([4, 16, 32]);
  }, 240_000);
});

/** A chain of `k` named shapes, each naming the next and giving `x` a runtime
 *  eval only where a choice of its own holds, beside a chain giving it a
 *  compile one everywhere — the two branches of one union in each of two
 *  kinds, and a `completedWhen` whose sibling is the first shape. */
function evalModeChain(k: number): string {
  const lines = ["kind: Telo.Application", "metadata: { name: EvalModeChain }", "variables:"];
  for (let i = 1; i <= k; i++) lines.push(`  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`);
  for (let i = 1; i <= k; i++) {
    const next = i < k ? `, next: { $ref: "telo://Self/S${i + 1}" }` : "";
    const fixedNext = i < k ? `, next: { $ref: "telo://Self/T${i + 1}" }` : "";
    lines.push(
      "---",
      "kind: Telo.JsonSchema",
      `metadata: { name: S${i} }`,
      "schema: !if",
      `  if: !cel "variables.flag${i}"`,
      `  then: { type: object, properties: { x: { x-telo-eval: runtime }${next} } }`,
      `  else: { type: object, properties: { x: { x-telo-eval: compile }${next} } }`,
      "---",
      "kind: Telo.JsonSchema",
      `metadata: { name: T${i} }`,
      `schema: { type: object, properties: { x: { x-telo-eval: compile }${fixedNext} } }`,
    );
  }
  for (const name of ["First", "Second"]) {
    lines.push(
      "---",
      "kind: Telo.Definition",
      `metadata: { name: ${name} }`,
      "capability: Telo.Invocable",
      `controllers: [pkg:telo/local/js?path=./probe.mjs#${name}]`,
      "schema:",
      "  type: object",
      "  properties:",
      '    content: { anyOf: [{ $ref: "telo://Self/S1" }, { $ref: "telo://Self/T1" }] }',
      "    action: { x-telo-ref: { kind: Telo.Invocable, use: call, inputs: /inputs, completedWhen: /content } }",
      "    inputs: { type: object, default: {} }",
    );
  }
  return lines.join("\n") + "\n";
}

describe("a union's eval modes and a completedWhen through varying named shapes", () => {
  it("are judged in the kind documents' stage alone, each shape class walked once, each pair of readings compared once: k=1, 4 and 8", async () => {
    const walks: number[] = [];
    const pairs: number[] = [];
    for (const k of [1, 4, 8]) {
      const loaded = await loadGenerated(`eval-mode-chain-${k}.yaml`, evalModeChain(k));
      const stages: { stage: string; inRun: boolean }[] = [];
      const walked: string[] = [];
      const compared: string[] = [];
      let renders = 0;
      const stopRenders = observeEvalModeBranchRenders(() => renders++);
      const stopStages = observeDocumentStages((stage, inRun) => {
        if (stage === "kindAnnotations") stages.push({ stage, inRun });
      });
      const stopShapes = observeShapeVerdicts((verdict, id, index) => {
        if (verdict.startsWith("evalModeWalk:")) walked.push(JSON.stringify([verdict, id, index]));
        if (verdict === "evalModeBranch") compared.push(id);
      });
      let found: ReturnType<StaticAnalyzer["analyze"]> = [];
      try {
        found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      } finally {
        stopStages();
        stopShapes();
        stopRenders();
      }
      expect(stages).toEqual([{ stage: "kindAnnotations", inRun: false }]);
      expect(new Set(walked).size).toBe(walked.length);
      expect(new Set(compared).size).toBe(compared.length);
      walks.push(walked.length);
      pairs.push(compared.length);
      // Each kind's union where some shape of the chain gives `x` a runtime
      // eval — worded by the two references its branches compare, each
      // finding rendered once — and nowhere else.
      const conflicts = found.filter((d) => d.code === "EVAL_MODE_BRANCH_CONFLICT");
      expect(renders).toBe(conflicts.length);
      for (const conflict of conflicts) expect(conflict.message).toContain("compares 'telo://Self/S1' with 'telo://Self/T1'");
      expect(new Set(conflicts.map((d) => (d.data as { resource?: { name?: string } }).resource?.name))).toEqual(new Set(["First", "Second"]));
      for (const conflict of conflicts) {
        const configurations = (conflict.data as { configurations?: Record<string, unknown>[] }).configurations ?? [];
        expect(configurations.length).toBeGreaterThan(0);
        expect(configurations.every((c) => Object.values(c).includes(true))).toBe(true);
      }
      // The sibling is no boolean in any configuration: one finding per kind, unlabelled.
      expect(found.filter((d) => d.code === "X_TELO_REF_INVALID_COMPLETED_WHEN")).toHaveLength(2);
    }
    // Linear in the chain's length, not in its configurations: each further
    // shape is walked once per class, and compared once per pair of classes.
    expect((walks[2]! - walks[1]!) / 4).toBe((walks[1]! - walks[0]!) / 3);
    expect(pairs[2]! - pairs[1]!).toBe(2 * 4);
  }, 240_000);
});
