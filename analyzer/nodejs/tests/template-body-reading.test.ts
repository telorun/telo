import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeBodyReadings } from "../src/cel-site-judgements.js";
import { isKindDocument } from "../src/kind-declaration.js";
import { liftedNodeCount } from "../src/template-body-projection.js";
import { holdsTemplateConstructs, type DefinitionWitness, type TemplateDefinitions } from "../src/template-definition-check.js";
import { elementIndexText, pathText, type LoopInstance, type TemplateBodyExpansion } from "../src/template-expansion.js";
import { fileCorpus, loadFile, ROOT } from "./configuration-corpus.js";
import { loadGenerated, RUN } from "./configuration-cost-fixtures.js";

/** Every manifest in the repository writing a choice or a repeat, and every
 *  configuration corpus fixture. */
function corpus(): string[] {
  const out = new Set(fileCorpus());
  const skip = new Set(["node_modules", ".telo", "dist", ".claude", ".git", "__generated__"]);
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/${entry.name}`);
      else if (entry.name.endsWith(".yaml")) {
        const text = readFileSync(join(dir, entry.name), "utf8")
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        if (/(?:^|:|-|---)\s*!(?:if|switch|for-each)\b/m.test(text) && text.includes("Telo.Definition")) {
          out.add(`${rel}/${entry.name}`.slice(1));
        }
      }
    }
  };
  for (const dir of ["tests", "modules", "examples", "starters", "blueprints", "analyzer/nodejs/tests"]) walk(join(ROOT, dir), `/${dir}`);
  return [...out].sort();
}

/** What an expansion says, compared whole: the body, its records, and where
 *  every position of it is written and which loops it stands in. */
function snapshot(expansion: TemplateBodyExpansion) {
  const paths: string[] = [];
  const visit = (value: unknown, keys: (string | number)[]) => {
    if (keys.length > 0) paths.push(pathText(keys));
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...keys, i]));
    else for (const [key, field] of Object.entries(value)) visit(field, [...keys, key]);
  };
  visit(expansion.definition, []);
  const frames = (instance: LoopInstance) =>
    instance.map((f) => [f.binding.name, f.binding.site, f.binding.keyed, elementIndexText(f.element)]);
  return {
    definition: expansion.definition,
    families: [...expansion.families].map(([key, f]) => [key, f.name, f.metadataAt, f.members]),
    mappings: expansion.mappings,
    emitted: expansion.emitted.map((e) => [e.at, e.written, frames(e.instance)]),
    splicedKeys: expansion.splicedKeys.map((s) => [s.container, s.key, s.sentinel, frames(s.instance)]),
    literalKeys: [...expansion.literalKeys],
    relocated: paths.map((p) => [p, expansion.relocate(p)]),
    instances: paths.map((p) => [p, frames(expansion.instanceAt(p))]),
  };
}

/** Which of `definition`'s body fields an expansion hands back as written. */
function writtenFields(expansion: TemplateBodyExpansion, definition: ResourceManifest) {
  const at = expansion.definition as Record<string, unknown>;
  return [
    at === definition,
    ...Object.keys(definition).map((key) => at[key] === (definition as Record<string, unknown>)[key]),
  ];
}

/** Every assignment of a definition's own dimensions and of the configuration
 *  dimensions its body reads, by local key. */
function definitionConfigurations(templates: TemplateDefinitions, definition: ResourceManifest): Record<string, unknown>[] {
  let out: Record<string, unknown>[] = [{}];
  for (const dimension of [...templates.dimensionsOf(definition), ...templates.configurationDimensionsOf(definition)]) {
    const next: Record<string, unknown>[] = [];
    for (const partial of out) {
      for (const value of dimension.values) next.push({ ...partial, [dimension.definition?.key ?? dimension.key]: value });
    }
    out = next;
  }
  return out;
}

/** The projection differential over every definition `manifests` hold: the
 *  reading projected at each definition configuration, and at each branch no
 *  value takes forced at its baseline, equals the decided expansion there. Returns how many witnesses it compared. */
function differential(manifests: ResourceManifest[], moduleDocuments: unknown): number {
  const result = new StaticAnalyzer().configurationsOf(manifests, { moduleDocuments: moduleDocuments as never });
  const { templates, union } = result;
  const withBodies = union.declarations.filter((d) => isKindDocument(d.manifest) && holdsTemplateConstructs(d.manifest));
  expect([...union.bodies.keys()]).toEqual(withBodies.map((d) => d.manifest));
  if (!templates) return 0;
  let compared = 0;
  for (const definition of templates.definitions) {
    const reading = union.bodies.get(definition)!;
    const configurations = definitionConfigurations(templates, definition);
    expect(configurations.length).toBeLessThanOrEqual(4096);
    for (const configuration of configurations) {
      const witness: DefinitionWitness = { assignmentOf: () => configuration };
      const projected = reading.project(witness);
      const decided = templates.decidedExpansion(definition, witness);
      expect(snapshot(projected), `${String(definition.metadata?.name)} at ${JSON.stringify(configuration)}`).toEqual(snapshot(decided));
      expect(writtenFields(projected, definition)).toEqual(writtenFields(decided, definition));
      compared++;
    }
    // Each branch no value takes, forced at its baseline, the configuration at
    // its first values.
    const first = Object.fromEntries(templates.configurationDimensionsOf(definition).map((d) => [d.key, d.values[0]]));
    for (const dead of reading.unreachable) {
      const witness: DefinitionWitness = { assignmentOf: () => ({ ...first, ...dead.baseline }), forcing: dead.forcing };
      const projected = reading.project(witness);
      const decided = templates.decidedExpansion(definition, witness);
      expect(snapshot(projected), `${String(definition.metadata?.name)} forcing ${dead.branch}`).toEqual(snapshot(decided));
      expect(writtenFields(projected, definition)).toEqual(writtenFields(decided, definition));
      compared++;
    }
  }
  return compared;
}

describe("a template body read once, projected at every way of deciding it", () => {
  const files = corpus();
  it.each(files)("%s", async (file) => {
    const loaded = await loadFile(join(ROOT, file));
    differential(loaded.manifests, loaded.moduleDocuments);
  }, 120_000);
});

const header = ["kind: Telo.Library", "metadata: { name: Bodies }", "imports:", `  Run: ${RUN}`];

/** Bodies nesting every construct: choices in choices, a family whose members
 *  differ in kind and a reference to one, a splice under a choice, step repeats,
 *  and branches no value takes — one nested in a taken branch. */
const NESTED = [
  ...header,
  "---",
  "kind: Telo.Definition",
  "metadata: { name: Nested }",
  "capability: Telo.Runnable",
  "schema:",
  "  type: object",
  "  properties:",
  "    mode: { type: string, enum: [a, b, c] }",
  "    on: { type: boolean }",
  "    names: { type: array, items: { type: string } }",
  "    items:",
  "      type: object",
  "      additionalProperties:",
  "        type: object",
  "        properties:",
  "          kind: { type: string, enum: [x, y] }",
  "resources:",
  "  - !if",
  "    metadata: { name: first }",
  '    if: !cel "self.on"',
  "    then:",
  "      kind: Telo.Value",
  "      value: !switch",
  '        switch: !cel "self.mode"',
  "        cases:",
  "          a: 1",
  "          b: !if",
  '            if: !cel "self.mode == \'a\'"',
  "            then: 2",
  "            else: 3",
  "        default: 4",
  "    else:",
  "      kind: Telo.Value",
  "      value: 0",
  "  - !for-each",
  "    metadata: { name: fam }",
  '    in: !cel "self.items"',
  "    emit: !if",
  '      if: !cel "each.value.kind == \'x\'"',
  "      then: { kind: Telo.Value, value: 1 }",
  "      else:",
  "        kind: Telo.Sequence",
  "        steps:",
  "          - { name: z, value: 1 }",
  "  - kind: Telo.Value",
  "    metadata: { name: spliced }",
  "    value:",
  "      fixed: 1",
  "      ...: !for-each",
  '        in: !cel "self.items"',
  '        key: !cel "each.key"',
  "        emit: !if",
  '          if: !cel "self.on"',
  "          then: { a: 1 }",
  "          else: { b: !if { if: !cel \"self.mode == 'c'\", then: 2, else: 3 } }",
  "  - kind: Telo.Sequence",
  "    metadata: { name: seq }",
  "    steps:",
  "      - !if",
  '        if: !cel "self.mode == \'a\'"',
  "        then: { name: s1, value: 1 }",
  "      - !for-each",
  '        in: !cel "self.names"',
  "        emit:",
  '          value: !if { if: !cel "self.on", then: 1, else: 2 }',
  "      - !for-each",
  '        in: !cel "self.items"',
  "        emit:",
  "          invoke: !ref fam[each.key]",
  "      - name: s3",
  "        value: !if",
  '          if: !cel "self.on"',
  "          then: 1",
  "          else: !if",
  "            if: true",
  "            then: 5",
  "            else: 6",
  "  - kind: Telo.Value",
  "    metadata: { name: dead }",
  "    value: !if",
  '      if: !cel "self.on || true"',
  "      then: !if",
  "        if: !cel \"self.mode == 'a' && self.mode == 'b'\"",
  "        then: 7",
  "        else: 8",
  "      else: 9",
  "targets:",
  "  - !if",
  '    if: !cel "self.on"',
  "    then: !ref seq",
].join("\n");

describe("a generated body holding every construct, nested", () => {
  it("projects at every definition configuration as the decided expansion", async () => {
    const loaded = await loadGenerated("template-body-reading-nested.yaml", `${NESTED}\n`);
    const compared = differential(loaded.manifests, loaded.moduleDocuments);
    // Twelve definition configurations and three forced dead branches.
    expect(compared).toBe(15);
  });
});

/** Entry K under `!if self.fK`, holding a type error and a reference to entry
 *  K−1. */
function structuralRow(k: number): string {
  const lines = [...header, "---", "kind: Telo.Definition", "metadata: { name: Row }", "capability: Telo.Invocable",
    "schema:", "  type: object", "  properties:"];
  for (let i = 0; i < k; i++) lines.push(`    f${i}: { type: boolean }`);
  lines.push("resources:");
  for (let i = 0; i < k; i++) {
    lines.push("  - !if", `    metadata: { name: e${i} }`, `    if: !cel "self.f${i}"`, "    then:", "      kind: Telo.Sequence",
      "      steps:", `        - { name: a, value: !cel "1 + 'a'" }`);
    if (i > 0) lines.push(`        - { name: b, invoke: !ref e${i - 1} }`);
  }
  lines.push("  - { kind: Telo.Value, metadata: { name: main }, value: 1 }", "invoke: !ref main");
  return `${lines.join("\n")}\n`;
}

describe("the structural row's reading", () => {
  it("is built once per kind document holding a body, with nodes linear in its choices", async () => {
    const nodes = new Map<number, number>();
    for (let k = 1; k <= 16; k++) {
      const loaded = await loadGenerated(`template-body-reading-row-${k}.yaml`, structuralRow(k));
      const read: object[] = [];
      const stop = observeBodyReadings((definition) => read.push(definition));
      const { union } = new StaticAnalyzer().configurationsOf(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      stop();
      const definitions = union.declarations.filter((d) => isKindDocument(d.manifest) && holdsTemplateConstructs(d.manifest));
      expect(read).toEqual(definitions.map((d) => d.manifest));
      nodes.set(k, liftedNodeCount(union.bodies.get(definitions[0]!.manifest)!.body));
    }
    // a·k + b, fitted at k = 2 and 4.
    const slope = (nodes.get(4)! - nodes.get(2)!) / 2;
    const intercept = nodes.get(2)! - 2 * slope;
    for (const [k, count] of nodes) expect(count, `k=${k}`).toBeLessThanOrEqual(slope * k + intercept);
  }, 300_000);

  it("is built once in an analysis, and no run enters it", async () => {
    const loaded = await loadGenerated("template-body-reading-row-2.yaml", structuralRow(2));
    const read: object[] = [];
    const stop = observeBodyReadings((definition) => read.push(definition));
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    stop();
    expect(read.map((d) => (d as ResourceManifest).metadata?.name)).toEqual(["Row"]);
  }, 120_000);
});
