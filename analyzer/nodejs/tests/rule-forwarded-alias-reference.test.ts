import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A rule reading a declaration another module exported, where that declaration
 * holds a reference written through an alias of ITS module (`!ref Store.rows`):
 * the analysis's own pass resolves it through the declaring module's import —
 * the alias kept, the kind canonical however that module spells it — so the
 * rule runs as it does over a local declaration. Loaded and analysed as a
 * host does; nothing here supplies a resolver.
 */

const KINDS = `kind: Telo.Library
metadata: { name: Kinds, version: 1.0.0 }
exports:
  kinds: [Table, Item, Holder]
---
kind: Telo.Definition
metadata: { name: Table }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    table: { type: string }
---
kind: Telo.Definition
metadata: { name: Item }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    table:
      x-telo-ref: { kind: Self.Table, use: dependency }
---
kind: Telo.Definition
metadata: { name: Holder }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    items:
      type: array
      items:
        x-telo-ref: { kind: Self.Item, use: dependency }
  x-telo-resource-rules:
    - resolve: [/items]
      condition: !cel "self.items.all(i, i.table.kind == 'Kinds.Table' && i.table.alias == 'Store' && i.table.name == 'rows')"
      code: ITEM_IN_STORE_ROWS
      message: every item must sit in the store's table named rows.
`;

// The store spells the kind through an alias of its own.
const STORE = `kind: Telo.Library
metadata: { name: Storage, version: 1.0.0 }
imports:
  K: ../kinds/telo.yaml
exports:
  resources: [rows, other]
---
kind: K.Table
metadata: { name: rows }
table: rows
---
kind: K.Table
metadata: { name: other }
table: other
`;

const lib = (table: string) => `kind: Telo.Library
metadata: { name: Lib, version: 1.0.0 }
imports:
  Kinds: ../kinds/telo.yaml
  Store: ../store/telo.yaml
exports:
  resources: [item]
---
kind: Kinds.Item
metadata: { name: item }
table: !ref Store.${table}
`;

const APP = `kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
imports:
  Kinds: ../kinds/telo.yaml
  Lib: ../lib/telo.yaml
---
kind: Kinds.Holder
metadata: { name: holder }
items:
  - !ref Lib.item
`;

async function ruleDiagnostics(table: string) {
  const files: Record<string, string> = {
    "/kinds/telo.yaml": KINDS,
    "/store/telo.yaml": STORE,
    "/lib/telo.yaml": lib(table),
    "/app/telo.yaml": APP,
  };
  const source: ManifestSource = {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
  const graph = await new Loader([source]).loadGraph("/app/telo.yaml", { desugarImports: true });
  expect(graph.errors).toEqual([]);
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => typeof d.code === "string" && /^(RESOURCE|REFERRER)_RULE_/.test(d.code))
    .map((d) => [d.code, d.data?.resource?.name, (d.data as { rule?: string } | undefined)?.rule]);
}

describe("a rule over an exported declaration holding an alias-qualified reference", () => {
  it("runs, reading the reference as its declaring module resolves it", async () => {
    expect(await ruleDiagnostics("rows")).toEqual([]);
  });

  it("reports a violation the resolved reference shows", async () => {
    expect(await ruleDiagnostics("other")).toEqual([
      ["RESOURCE_RULE_VIOLATED", "holder", "ITEM_IN_STORE_ROWS"],
    ]);
  });
});
