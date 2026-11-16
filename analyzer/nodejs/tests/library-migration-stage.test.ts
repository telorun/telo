import { describe, expect, it } from "vitest";
import { parseManifestDocuments } from "../src/yaml-ast.js";
import { observeDefinitionRegistrations } from "../src/definition-registration.js";
import { analyzeLoadedGraph } from "../src/graph-analysis.js";
import { readLibraryMigrations } from "../src/library-migrations/declaration.js";
import { applyMigrationRule } from "../src/library-migrations/rule-application.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
}

const yaml = (text: string) => parseManifestDocuments(text)[0]!.toJSON();

const MIGRATIONS = (blocks: string) => `kind: Telo.Library
metadata: { name: Lib }
lang: en
exports: { kinds: [Thing, Other] }
migrations:
${blocks}
---
kind: Telo.Definition
metadata: { name: Thing }
capability: Telo.Invocable
schema: { type: object, additionalProperties: false, properties: { renamed: { type: integer } } }
---
kind: Telo.Definition
metadata: { name: Other }
capability: Telo.Invocable
schema: { type: object, additionalProperties: false, properties: { moved: { type: integer } } }
`;

const THING_RULE = `  LIB_THING_RENAMED:
    reason: Old is renamed.
    rules:
      - { rewrite: Self.Thing, match: { type: object, required: [old] }, move: { /old: /renamed } }`;
const OTHER_RULE = `  LIB_OTHER_MOVED:
    reason: Before is moved.
    rules:
      - { rewrite: Self.Other, match: { type: object, required: [before] }, move: { /before: /moved } }`;

const APP = `kind: Telo.Application
metadata: { name: App }
lang: en
imports: { L: ../lib/telo.yaml }
targets: []
---
kind: L.Thing
metadata: { name: thing }
old: 1
---
kind: L.Other
metadata: { name: other }
before: 2
`;

const load = (files: Record<string, string>) =>
  new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", { desugarImports: true, migrate: true });

const docsOf = (graph: Awaited<ReturnType<typeof load>>) => graph.entry.owner.manifests.slice(1, 3);

describe("library migration rule application", () => {
  const rule = readLibraryMigrations(
    yaml(`kind: Telo.Library
metadata: { name: Ui }
migrations:
  UI_LINK_HREF_MOVED:
    reason: r
    rules:
      - rewrite: Self.Node
        match: { type: object, required: [href] }
        move: { /href: /to/href }
        set: { to: { kind: Self.Navigate } }
`),
  )[0]!.rules[0]!;
  const spell = (written: string) => ({ kind: written.replace("Self.", "U.") });

  for (const [label, href] of [
    ["a map holding a reference", "{ path: !ref authors }"],
    ["a choice", '!if { if: !cel "variables.x", then: /a, else: /b }'],
    ["an expression", '!cel "row.id"'],
  ] as const) {
    it(`places ${label} at the destination exactly as written`, () => {
      const node = yaml(`{ type: link, text: T, href: ${href} }`) as Record<string, unknown>;
      const applied = applyMigrationRule(node, rule, spell);
      expect(applied).toEqual({ value: { type: "link", text: "T", to: { kind: "U.Navigate", href: node.href } } });
      expect(((applied as { value: { to: { href: unknown } } }).value.to.href)).toBe(node.href);
    });
  }
});

describe("library migration rule removals", () => {
  it("judges every removed list item against the node as found", () => {
    const rule = readLibraryMigrations(
      yaml(`kind: Telo.Library
metadata: { name: Ui }
migrations:
  UI_NODE_ITEMS_REMOVED:
    reason: r
    rules:
      - { rewrite: Self.Node, match: { type: object, required: [a] }, remove: [/a/0, /a/1] }
`),
    )[0]!.rules[0]!;
    const applied = applyMigrationRule(yaml("{ a: [x, y, z, w] }"), rule, (written) => ({ kind: written }));
    expect(applied).toEqual({ value: { a: ["z", "w"] } });
  });
});

describe("library migration stage", () => {
  it("allocates nothing for a closure declaring no migrations", async () => {
    const graph = await load({ "/app/telo.yaml": APP, "/lib/telo.yaml": MIGRATIONS("  {}").replace("migrations:\n  {}\n", "") });
    const before = [...graph.modules.values()];
    await analyzeLoadedGraph(graph);
    expect(graph.libraryMigrations).toBeUndefined();
    expect([...graph.modules.values()]).toEqual(before);
    expect([...graph.modules.values()].every((m, i) => m === before[i])).toBe(true);
  });

  it("migrates the graph's own copies, never the loader's cached files, once per root", async () => {
    const files = { "/app/telo.yaml": APP, "/lib/telo.yaml": MIGRATIONS(THING_RULE) };
    const loader = new Loader([inMemorySource(files)]);
    const options = { desugarImports: true, migrate: true };
    let registrations = 0;
    const stop = observeDefinitionRegistrations(() => registrations++);
    const migrated = await loader.loadGraph("/app/telo.yaml", options);
    const analysis = await analyzeLoadedGraph(migrated);
    stop();
    expect(analysis.diagnostics.map((d) => d.code)).toContain("LIB_THING_RENAMED");
    // One registration per analysed root: the entry, and each library verdict.
    expect(registrations).toBe(1 + analysis.dependencies.verdicts.length);
    expect(docsOf(migrated)[0]).toMatchObject({ renamed: 1 });
    expect(docsOf(migrated)[0]).not.toHaveProperty("old");
    const cached = await loader.loadModule("/app/telo.yaml", options);
    expect(cached.owner.manifests[1]).toMatchObject({ old: 1 });
    expect(cached.owner).not.toBe(migrated.entry.owner);
  });

  it("changes only the nodes of a rule when another rule is deleted", async () => {
    const both = await load({ "/app/telo.yaml": APP, "/lib/telo.yaml": MIGRATIONS(`${THING_RULE}\n${OTHER_RULE}`) });
    const one = await load({ "/app/telo.yaml": APP, "/lib/telo.yaml": MIGRATIONS(THING_RULE) });
    await analyzeLoadedGraph(both);
    await analyzeLoadedGraph(one);
    expect(docsOf(both)[0]).toEqual(docsOf(one)[0]);
    expect(docsOf(both)[1]).toMatchObject({ moved: 2 });
    expect(docsOf(one)[1]).toMatchObject({ before: 2 });
  });
});

describe("library migration named shapes", () => {
  it("recognizes a named shape declared through a kind extending Telo.JsonSchema", async () => {
    const lib = `kind: Telo.Library
metadata: { name: Lib }
lang: en
exports: { kinds: [Thing, Shape] }
migrations:
  LIB_NODE_RENAMED:
    reason: Old is renamed.
    rules:
      - { rewrite: Self.Node, match: { type: object, required: [old] }, move: { /old: /renamed } }
---
kind: Telo.Definition
metadata: { name: Shape }
extends: Telo.JsonSchema
---
kind: Self.Shape
metadata: { name: Node }
schema: { type: object, additionalProperties: false, properties: { renamed: { type: integer } } }
---
kind: Telo.Definition
metadata: { name: Thing }
capability: Telo.Invocable
schema: { type: object, additionalProperties: false, properties: { node: { $ref: "telo://Self/Node" } } }
`;
    const app = `kind: Telo.Application
metadata: { name: App }
lang: en
imports: { L: ../lib/telo.yaml }
targets: []
---
kind: L.Thing
metadata: { name: thing }
node: { old: 1 }
`;
    const graph = await load({ "/app/telo.yaml": app, "/lib/telo.yaml": lib });
    const analysis = await analyzeLoadedGraph(graph);
    expect(analysis.diagnostics.map((d) => d.code)).toContain("LIB_NODE_RENAMED");
    expect(graph.entry.owner.manifests[1]).toMatchObject({ node: { renamed: 1 } });
  });
});

describe("library migration stage gating and retyping", () => {
  it("runs no stage over a load that is not migrated", async () => {
    const files = { "/app/telo.yaml": APP, "/lib/telo.yaml": MIGRATIONS(THING_RULE) };
    const loader = new Loader([inMemorySource(files)]);
    const options = { desugarImports: true, migrate: false };
    const graph = await loader.loadGraph("/app/telo.yaml", options);
    expect(graph.migrate).toBe(false);
    const before = [...graph.modules.values()];
    await analyzeLoadedGraph(graph);
    expect(graph.libraryMigrations).toBeUndefined();
    expect([...graph.modules.values()].every((m, i) => m === before[i])).toBe(true);
    expect(docsOf(graph)[0]).toMatchObject({ old: 1 });
  });

  const RETYPE = (first: [string, string], second: [string, string]) => `kind: Telo.Library
metadata: { name: Lib }
lang: en
exports: { kinds: [New, Other] }
migrations:
  ${first[0]}:
    reason: Old is replaced.
    rules:
      - { rewrite: Self.Old, match: { type: object, required: [a] }, set: { kind: ${first[1]} } }
  ${second[0]}:
    reason: Old is replaced again.
    rules:
      - { rewrite: Self.Old, match: { type: object, required: [b] }, set: { kind: ${second[1]} } }
---
kind: Telo.Definition
metadata: { name: New }
capability: Telo.Invocable
schema: { type: object, additionalProperties: false, properties: {} }
---
kind: Telo.Definition
metadata: { name: Other }
capability: Telo.Invocable
schema: { type: object, additionalProperties: false, properties: {} }
`;
  const PANEL = `kind: Telo.Library
metadata: { name: Panel }
lang: en
imports: { L: ../lib/telo.yaml }
resources:
  input: { kind: L.Old, optional: true }
`;
  const retyped = async (library: string) => {
    const graph = await new Loader([
      inMemorySource({
        "/app/telo.yaml": "kind: Telo.Application\nmetadata: { name: App }\nlang: en\nimports: { P: ../panel/telo.yaml }\ntargets: []\n",
        "/panel/telo.yaml": PANEL,
        "/lib/telo.yaml": library,
      }),
    ]).loadGraph("/app/telo.yaml", { desugarImports: true, migrate: true });
    await analyzeLoadedGraph(graph);
    const panel = graph.modules.get("/panel/telo.yaml")!.owner.manifests[0] as { resources: { input: { kind: string } } };
    return panel.resources.input.kind;
  };

  it("retypes a kind-only declaration by the kinds its rules write, whatever order their codes sort in", async () => {
    expect(await retyped(RETYPE(["AAA_OLD_REPLACED", "Self.New"], ["ZZZ_OLD_REPLACED", "Self.New"]))).toBe("L.New");
    expect(await retyped(RETYPE(["ZZZ_OLD_REPLACED", "Self.New"], ["AAA_OLD_REPLACED", "Self.New"]))).toBe("L.New");
    expect(await retyped(RETYPE(["AAA_OLD_REPLACED", "Self.New"], ["ZZZ_OLD_REPLACED", "Self.Other"]))).toBe("L.Old");
    expect(await retyped(RETYPE(["AAA_OLD_REPLACED", "Self.Other"], ["ZZZ_OLD_REPLACED", "Self.New"]))).toBe("L.Old");
  });
});

describe("library migration targets", () => {
  const gone = (set: string) =>
    MIGRATIONS(`  LIB_GONE_RENAMED:
    reason: Gone is renamed.
    rules:
      - { rewrite: Self.Gone, match: { type: object, required: [old] }, move: { /old: /renamed }${set} }`);
  const APP_GONE = `kind: Telo.Application
metadata: { name: App }
lang: en
imports: { L: ../lib/telo.yaml }
targets: []
---
kind: L.Gone
metadata: { name: gone }
old: 1
`;
  it("reads an undeclared target as a removed kind only when a rule gives it a kind", async () => {
    const untouched = await load({ "/app/telo.yaml": APP_GONE, "/lib/telo.yaml": gone("") });
    await analyzeLoadedGraph(untouched);
    expect(untouched.entry.owner.manifests[1]).toMatchObject({ kind: "L.Gone", old: 1 });
    const migrated = await load({ "/app/telo.yaml": APP_GONE, "/lib/telo.yaml": gone(", set: { kind: Self.Thing }") });
    await analyzeLoadedGraph(migrated);
    expect(migrated.entry.owner.manifests[1]).toMatchObject({ kind: "L.Thing", renamed: 1 });
  });
});

describe("library migration shapes read off the graph", () => {
  const LIB = `kind: Telo.Library
metadata: { name: Lib }
lang: en
exports: { kinds: [Box], resources: [Item, Base] }
migrations:
  LIB_ITEM_OLD_RENAMED:
    reason: Old is the label.
    rules:
      - { rewrite: Self.Item, match: { type: object, required: [old] }, move: { /old: /label } }
  LIB_BOX_BAD_MOVED:
    reason: Bad is the item's size.
    rules:
      - { rewrite: Self.Box, match: { type: object, required: [bad] }, move: { /bad: /item/size } }
---
kind: Telo.JsonSchema
metadata: { name: Base }
schema: { type: object, properties: { label: { type: string } } }
---
kind: Telo.JsonSchema
metadata: { name: Item }
extends: Base
schema:
  type: object
  additionalProperties: false
  $defs: { Size: { type: integer } }
  properties: { size: { $ref: "#/$defs/Size" } }
---
kind: Telo.Definition
metadata: { name: Box }
capability: Telo.Invocable
schema: { type: object, additionalProperties: false, properties: { item: { $ref: "telo://Self/Item" } } }
`;
  const app = (item: string) => `kind: Telo.Application
metadata: { name: App }
lang: en
imports: { L: ../lib/telo.yaml }
targets: []
---
kind: L.Box
metadata: { name: box }
${item}
`;
  it("validates a converged shape value against the shape with its parents folded and its local references kept", async () => {
    const inherited = await load({ "/app/telo.yaml": app("item: { old: Hi }"), "/lib/telo.yaml": LIB });
    const { diagnostics: clean } = await analyzeLoadedGraph(inherited);
    expect(clean.filter((d) => d.code === "MIGRATION_FAILED")).toEqual([]);
    expect(inherited.entry.owner.manifests[1]).toMatchObject({ item: { label: "Hi" } });
    const local = await load({ "/app/telo.yaml": app("bad: wide"), "/lib/telo.yaml": LIB });
    const { diagnostics } = await analyzeLoadedGraph(local);
    expect(diagnostics.find((d) => d.code === "MIGRATION_FAILED")?.message).toContain("fails the current schema at /item/size");
  });
});
