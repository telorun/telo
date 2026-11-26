import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { readExpansionSites } from "../src/expansion-sites.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { assembleGraphDiagnostics } from "../src/graph-diagnostics.js";
import { Loader } from "../src/manifest-loader.js";
import { readTemplateDefinitions } from "../src/template-definition-check.js";
import type { AnalysisDiagnostic, ManifestSource } from "../src/types.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/template-definitions");

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

async function check(file: string): Promise<AnalysisDiagnostic[]> {
  const graph = await new Loader([fileSource]).loadGraph(join(FIXTURES, file), { desugarImports: true });
  const analysis = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
    moduleDocuments: collectModuleDocuments(graph),
  });
  return assembleGraphDiagnostics(graph, analysis).diagnostics;
}

const summary = (diagnostics: AnalysisDiagnostic[]) =>
  diagnostics.map((d) => `${d.code} ${(d.data as { path?: string } | undefined)?.path}`).sort();

describe("a template definition checked with no consumer", () => {
  it("types each loop's binding from its source, and relocates findings to the emit as written", async () => {
    const diagnostics = await check("routes.yaml");
    expect(summary(diagnostics)).toEqual([]);
  });

  it("reports a body field's schema finding once, under the choice its value is chosen by", async () => {
    const found = (await check("field-choice.yaml")).filter((d) => d.code === "SCHEMA_VIOLATION");
    expect(found.map((d) => [(d.data as { path?: string }).path, d.message])).toEqual([
      ["inputs.else", "Telo.Definition/Picked: /inputs/else must be object (when self.f is false)"],
    ]);
  });

  it("reports a typo inside an emit, a branch nobody selects and a case outside the domain", async () => {
    const diagnostics = await check("refusals.yaml");
    const choices = diagnostics.filter((d) => d.message.startsWith("Telo.Definition/Choices"));
    expect(summary(choices)).toEqual([
      "BRANCH_CASE_KEY_INVALID resources[2].mounts[1].cases.yes",
      "BRANCH_CASE_KEY_INVALID resources[2].mounts[2].cases.01",
      "BRANCH_CASE_UNREACHABLE resources[0].cases.c",
      "BRANCH_NOT_EXHAUSTIVE resources[0]",
      "BRANCH_NOT_EXHAUSTIVE resources[1]",
      "BRANCH_UNDECIDABLE resources[2].mounts[3].if",
      "SCHEMA_VIOLATION resources[0].cases.a.mounts",
      "SCHEMA_VIOLATION resources[0].cases.c.mounts",
      "SCHEMA_VIOLATION resources[1].cases.x.mounts",
      "SCHEMA_VIOLATION resources[2].mounts[0].cases.b",
      "TEMPLATE_TARGET_UNKNOWN targets[0]",
    ]);
    // What the message lists is the body as written, whichever way it is decided.
    const target = choices.find((d) => d.code === "TEMPLATE_TARGET_UNKNOWN")!;
    expect(target.message).toBe(
      "Telo.Definition/Choices: 'targets[0]: !ref server' names no entry in 'resources:'. Available: other, third. (when self.mode is b)",
    );
    const typo = choices.find((d) => (d.data as { path?: string }).path === "resources[2].mounts[0].cases.b")!;
    expect(typo.message).toMatch(/\(when self\.mode is b\)$/);
    const unselected = choices.find((d) => (d.data as { path?: string }).path === "resources[0].cases.c.mounts")!;
    expect(unselected.message).toMatch(/in a branch no value the definition can be given takes\)$/);
  });

  it("refuses a source, a binding name and an emitted name", async () => {
    const diagnostics = await check("refusals.yaml");
    const repeats = diagnostics.filter((d) => d.message.startsWith("Telo.Definition/Repeats"));
    expect(summary(repeats)).toEqual([
      "BINDING_NAME_RESERVED resources[0].routes[1].emit[0]",
      "BINDING_NAME_RESERVED resources[0].routes[2].as",
      "BINDING_NAME_RESERVED resources[1].value[0]",
      "REPEAT_EMIT_INVALID resources[0].routes[3].emit",
      "REPEAT_SOURCE_INVALID resources[0].routes[0].in",
    ]);
  });

  it("reports `each.key` over a list as an unknown field", async () => {
    const graph = await new Loader([fileSource]).loadGraph(join(FIXTURES, "routes.yaml"), { desugarImports: true });
    const flat = flattenForAnalyzer(graph);
    const definition = flat.find((m) => m.metadata?.name === "Receiver")! as Record<string, any>;
    const repeat = definition.resources[0].routes[1].emit[0];
    repeat.emit.request.path = { ...repeat.emit.request.path, source: "/${{ op.key }}" };
    const diagnostics = new StaticAnalyzer().analyze(flat, { moduleDocuments: collectModuleDocuments(graph) });
    expect(summary(diagnostics)).toEqual(["CEL_UNKNOWN_FIELD resources[0].routes[1].emit[0].emit.request.path"]);
  });

  it("decides mirrored conditions together and names both atoms of unrelated ones", async () => {
    const diagnostics = await check("servers.yaml");
    expect(diagnostics.map((d) => d.message)).toEqual([
      "Telo.Definition/Unrelated: 'targets[0]: !ref adminServer' names no entry in 'resources:'. Available: (none). " +
        "(when 'self.a < self.b' is false and 'self.a >= self.b' is true)",
    ]);
    expect((diagnostics[0]!.data as { configurations?: unknown }).configurations).toBeUndefined();
  });
});

describe("a splice at the definition", () => {
  it("holds its representative entry to every value schema a key of the mapping could receive", async () => {
    const diagnostics = await check("splice.yaml");
    expect(summary(diagnostics)).toEqual(["SCHEMA_VIOLATION resources[1].columns.....emit"]);
  });
});

describe("a template body as one consumer expands it", () => {
  it("reads through a reference into the consumer's own declaration, never into another module's", async () => {
    const diagnostics = await check("crossings.yaml");
    expect(summary(diagnostics)).toEqual(["BRANCH_UNDECIDABLE target"]);
    expect(diagnostics[0]!.message).toContain("crosses into a declaration of module 'CrossingLib'");
  });

  it("refuses a computed source and an integer-like key, and checks a forwarded element as the entry's field", async () => {
    const diagnostics = await check("consumer.yaml");
    expect(summary(diagnostics)).toEqual([
      "REFERENCE_KIND_MISMATCH hooks.github.status",
      "REPEAT_COMPUTED tables",
      "REPEAT_NUMERIC_KEY hooks.2024",
    ]);
    const forwarded = diagnostics.find((d) => d.code === "REFERENCE_KIND_MISMATCH")!;
    expect(forwarded.message).toContain("is forwarded into the Http.Api entry 'api'");
  });

  it("refuses a spliced key a literal holds, and an open value a choice reads", async () => {
    const diagnostics = await check("splice-consumer.yaml");
    expect(summary(diagnostics)).toEqual(["BRANCH_UNDECIDABLE adminPort", "REPEAT_KEY_DUPLICATE fields.id"]);
  });
});

describe("the definition-check model", () => {
  /** A body of `n` entries, each holding one open field-value `!if` reading no
   *  reference, beside one declaration-position `!if` over an enum. */
  const generated = (n: number) => {
    const entries = Array.from({ length: n }, (_, i) =>
      [
        `  - kind: Telo.Value`,
        `    metadata: { name: value${i} }`,
        `    value: !if`,
        `      if: !cel "self.a${i} == self.b${i}"`,
        `      then: 1`,
        `      else: 2`,
      ].join("\n"),
    );
    const properties = Array.from({ length: n }, (_, i) => `    a${i}: { type: integer }\n    b${i}: { type: integer }`);
    return [
      `kind: Telo.Library`,
      `metadata: { name: Cost }`,
      `imports:`,
      `  Run: ${resolve(FIXTURES, "../../../../../modules/run")}`,
      `---`,
      `kind: Telo.Definition`,
      `metadata: { name: Wide }`,
      `capability: Telo.Invocable`,
      `schema:`,
      `  type: object`,
      `  properties:`,
      `    dialect: { type: string, enum: [a, b] }`,
      ...properties,
      `resources:`,
      `  - !if`,
      `    metadata: { name: chosen }`,
      `    if: !cel "self.dialect == 'a'"`,
      `    then: { kind: Telo.Value, value: 1 }`,
      `    else: { kind: Telo.Value, value: 2 }`,
      ...entries,
      `invoke: !ref chosen`,
    ].join("\n");
  };

  for (const n of [1, 8, 16]) {
    it(`reads the body over one dimension per choice, with no variant product — ${n} open choices`, async () => {
      const text = generated(n);
      const source: ManifestSource = {
        supports: (url) => url === "/virtual/cost.yaml" || fileSource.supports(url),
        read: async (url) => (url === "/virtual/cost.yaml" ? { text, source: url } : fileSource.read(url)),
        resolveRelative: fileSource.resolveRelative,
      };
      const graph = await new Loader([source]).loadGraph("/virtual/cost.yaml", { desugarImports: true });
      const flat = flattenForAnalyzer(graph);
      const registry = new AnalysisRegistry();
      new StaticAnalyzer().analyze(flat, { skipValidation: true }, registry);
      const ctx = registry._context();
      const templates = readTemplateDefinitions({
        manifests: flat,
        reading: readExpansionSites(flat, [], ctx.definitions!, ctx.aliases, ctx.aliasesByModule, true),
        registry: ctx.definitions!,
        aliases: ctx.aliases!,
        aliasesByModule: ctx.aliasesByModule ?? new Map(),
      });
      const definition = templates.definitions.find((d) => d.metadata?.name === "Wide")!;
      expect(templates.dimensionsOf(definition)).toHaveLength(n + 1);
    });
  }
});

describe("a template definition's own dimensions", () => {
  const text = [
    `kind: Telo.Library`,
    `metadata: { name: Dims }`,
    `imports:`,
    `  Run: ${resolve(FIXTURES, "../../../../../modules/run")}`,
    `---`,
    `kind: Telo.Definition`,
    `metadata: { name: Roles }`,
    `capability: Telo.Invocable`,
    `schema:`,
    `  type: object`,
    `  properties:`,
    `    dialect: { type: string, enum: [a, b] }`,
    `    a: { type: integer }`,
    `    b: { type: integer }`,
    `    name: { type: string }`,
    `resources:`,
    `  - kind: Run.Value`,
    `    metadata: { name: closed }`,
    `    value: !if { if: !cel "self.dialect == 'a'", then: 1, else: 2 }`,
    `  - kind: Run.Value`,
    `    metadata: { name: atom }`,
    `    value: !if { if: !cel "self.a == self.b", then: 1, else: 2 }`,
    `  - kind: Run.Value`,
    `    metadata: { name: selector }`,
    `    value: !switch { switch: !cel "self.name", cases: { x: 1 }, default: 2 }`,
    `invoke: !ref closed`,
  ].join("\n");
  const load = async () => {
    const source: ManifestSource = {
      supports: (url) => url === "/virtual/dims.yaml" || fileSource.supports(url),
      read: async (url) => (url === "/virtual/dims.yaml" ? { text, source: url } : fileSource.read(url)),
      resolveRelative: fileSource.resolveRelative,
    };
    return flattenForAnalyzer(await new Loader([source]).loadGraph("/virtual/dims.yaml", { desugarImports: true }));
  };

  it.each([
    ["closed", "self.dialect", ["a", "b"]],
    ["atom", "self.a == self.b", [true, false]],
    ["selector", "self.name", ["x", "\0other"]],
  ])("registers a %s read as a dimension keyed by the definition's identity", async (role, key, values) => {
    const flat = await load();
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(flat, { skipValidation: true }, registry);
    const ctx = registry._context();
    const templates = readTemplateDefinitions({
      manifests: flat,
      reading: readExpansionSites(flat, [], ctx.definitions!, ctx.aliases, ctx.aliasesByModule, true),
      registry: ctx.definitions!,
      aliases: ctx.aliases!,
      aliasesByModule: ctx.aliasesByModule ?? new Map(),
    });
    const definition = templates.definitions.find((d) => d.metadata?.name === "Roles")!;
    expect(templates.dimensionsOf(definition).filter((d) => d.definition?.role === role)).toEqual([
      { key: `Dims.Roles:${key}`, values, definition: { identity: "Dims.Roles", role, key } },
    ]);
  });

  it("is refused as a key of 'within'", async () => {
    const flat = await load();
    expect(() => new StaticAnalyzer().analyze(flat, { within: { "Dims.Roles:self.dialect": "a" } })).toThrow(
      `'within' names 'Dims.Roles:self.dialect', the closed dimension 'self.dialect' of the template definition ` +
        `'Dims.Roles': each consumer decides a definition's dimensions, so no configuration names one.`,
    );
  });
});

describe("a family and its member references at the definition", () => {
  it("checks a family's emit, and refuses each reference a member's bindings do not prove", async () => {
    const diagnostics = await check("families.yaml");
    expect(summary(diagnostics)).toEqual([
      "BRANCH_CASE_INVALID resources[1].else",
      "DUPLICATE_RESOURCE_NAME resources[1].metadata.name",
      "REF_MEMBER_INVALID targets[0]",
      "REF_MEMBER_INVALID targets[1].emit",
      "REF_MEMBER_INVALID targets[1].emit.emit.emit",
      "REF_MEMBER_INVALID targets[2].emit",
      "REF_MEMBER_INVALID targets[2].emit",
      "REF_MEMBER_INVALID targets[3].emit",
      "REF_MEMBER_INVALID targets[4]",
      "REF_MEMBER_INVALID targets[5].emit",
      "REPEAT_EMIT_INVALID resources[2].emit",
      "REPEAT_EMIT_INVALID resources[3].emit",
      "SCHEMA_VIOLATION resources[0].emit",
    ].sort());
    const typo = diagnostics.find((d) => d.code === "SCHEMA_VIOLATION")!;
    expect(typo.message).toContain("'crno' is not allowed");
  });
});

describe("a step repeat at the definition", () => {
  it("types a named repeat's results as a map by key, and refuses what its emit cannot be", async () => {
    const diagnostics = await check("step-repeats.yaml");
    expect(summary(diagnostics)).toEqual([
      "CEL_UNKNOWN_FIELD resources[0].steps[1].emit.value",
      "REPEAT_EMIT_INVALID resources[0].steps[2].emit.name",
      "REPEAT_EMIT_INVALID resources[0].steps[3].emit",
      "REPEAT_EMIT_INVALID resources[0].steps[4].emit",
      "REPEAT_POSITION_INVALID resources[0].steps[5].__emitted",
    ]);
  });
});

describe("a template body's `resources`", () => {
  it("holds the body's entries, types a family by element key, refuses a startup status read, and is unknown outside the body", async () => {
    const diagnostics = await check("body-resources.yaml");
    expect(summary(diagnostics)).toEqual([
      "CEL_UNKNOWN_FIELD resources[3].steps[0].emit.value",
      "CEL_UNKNOWN_FIELD resources[3].steps[2].value",
      "CEL_UNKNOWN_FIELD resources[3].steps[3].value",
      "CEL_UNKNOWN_FIELD steps[0].value",
      "OBSERVED_STATE_IN_STARTUP_FIELD resources[2].keys.runs",
      // Read through a family's index, the same startup rule.
      "OBSERVED_STATE_IN_STARTUP_FIELD resources[4].keys.runs",
      // A loop source reads the body's entries: it is judged as a source (a
      // reading is no collection), not as an unknown field.
      "REPEAT_SOURCE_INVALID resources[5].in",
      "REPEAT_SOURCE_INVALID resources[6].in",
    ]);
    const family = diagnostics.find((d) => (d.data as { path?: string }).path === "resources[3].steps[0].emit.value")!;
    expect(family.message).toContain("runz");
  });
});

describe("a loop over a refused source", () => {
  const of = async (name: string) =>
    summary((await check("refused-source.yaml")).filter((d) => d.message.startsWith(`Telo.Definition/${name}:`)));

  it("is the one finding: every read of its binding and a member reference through it are accepted", async () => {
    expect(await of("Refused")).toEqual(["REPEAT_SOURCE_INVALID resources[0].in"]);
  });

  it("still leaves a misspelled root refused", async () => {
    expect(await of("Misspelled")).toEqual([
      "CEL_UNKNOWN_IDENTIFIER resources[0].emit.note",
      "REPEAT_SOURCE_INVALID resources[0].in",
    ]);
  });

  it("poisons a loop over its value silently, expanded or left as written", async () => {
    expect(await of("Nested")).toEqual(["REPEAT_SOURCE_INVALID resources[0].in"]);
  });

  it("types its binding again once the source is declared", async () => {
    expect(await of("Declared")).toEqual(["CEL_UNKNOWN_FIELD resources[0].emit.label"]);
  });
});
