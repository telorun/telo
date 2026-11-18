import { describe, expect, it } from "vitest";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { METADATA_STAMPS } from "../src/metadata-stamps.js";
import type { ManifestSource } from "../src/types.js";

function source(files: Record<string, string>): ManifestSource {
  const dirOf = (file: string) => file.slice(0, file.lastIndexOf("/") + 1);
  return {
    supports: () => true,
    async read(url) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base, relative) => dirOf(base) + relative.replace(/^\.\//, ""),
  };
}

const load = (files: Record<string, string>) =>
  new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });

describe("METADATA_RESERVED_FIELD", () => {
  it("refuses every listed stamp an entry document writes, at the key", async () => {
    const stamps = [...METADATA_STAMPS];
    const app = [
      "kind: Telo.Application",
      "metadata: { name: App }",
      "---",
      "kind: Telo.Definition",
      "metadata:",
      "  name: Greeter",
      ...stamps.map((field) => `  ${field}: x`),
      "capability: Telo.Invocable",
      "schema: { type: object }",
    ].join("\n");
    const graph = await load({ "/app/telo.yaml": app });
    expect(
      graph.metadataDiagnostics.map((d) => ({
        code: d.code,
        path: (d.data as { path: string }).path,
        line: d.range?.start.line,
      })),
    ).toEqual(stamps.map((field, i) => ({ code: "METADATA_RESERVED_FIELD", path: `metadata.${field}`, line: 6 + i })));
  });

  it("reports a library's at the scope member whose import first reaches it", async () => {
    const graph = await load({
      "/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: App }",
        "---",
        "kind: Telo.Sequence",
        "metadata: { name: seq }",
        "with:",
        "  - kind: Telo.Import",
        "    metadata: { name: Inner }",
        "    source: ./lib/telo.yaml",
        "steps: []",
      ].join("\n"),
      "/app/lib/telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: Lib }",
        "---",
        "kind: Telo.Definition",
        "metadata: { name: Greeter, module: Elsewhere }",
        "capability: Telo.Invocable",
        "schema: { type: object }",
      ].join("\n"),
    });
    expect(graph.metadataDiagnostics.map((d) => [d.message, d.data])).toEqual([
      [
        "Imported library 'Lib', reached through import 'Inner': Telo.Definition/Greeter: 'metadata.module' " +
          "is written by the loader — the module the document belongs to — and cannot be written in a manifest. Remove it.",
        {
          filePath: "/app/telo.yaml",
          path: "with[0]",
          resource: { kind: "Telo.Sequence", name: "seq" },
          writtenAt: { resource: { kind: "Telo.Definition", name: "Greeter" }, filePath: "/app/lib/telo.yaml", path: "metadata.module" },
        },
      ],
    ]);
  });

  it("lists every key flattening stamps onto metadata", async () => {
    const files = {
      "/app/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: App, version: 1.0.0 }",
        "imports:",
        "  A: ./a/telo.yaml",
        "  B: { source: ./b/telo.yaml, resources: { conn: !ref A.thing } }",
        "needs: { db: { kind: A.Db, optional: true } }",
        "---",
        "kind: Telo.Sequence",
        "metadata: { name: seq }",
        "with:",
        "  - kind: Telo.Import",
        "    metadata: { name: Inner }",
        "    source: ./a/telo.yaml",
        "steps: []",
      ].join("\n"),
      "/app/a/telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: A, version: 1.0.0 }",
        "variables: { root: { x-telo-type: Telo.HostPath } }",
        "needs: { db: { kind: Self.Db, optional: true } }",
        "exports: { kinds: [Thing, Db], resources: [thing] }",
        "---",
        "kind: Telo.NeedType",
        "metadata: { name: Db }",
        "fields: { url: { type: string } }",
        "---",
        "kind: Telo.Definition",
        "metadata: { name: Thing }",
        "capability: Telo.Provider",
        "schema: { type: object }",
        "---",
        "kind: Self.Thing",
        "metadata: { name: thing }",
      ].join("\n"),
      "/app/b/telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: B }",
        "lifecycle: shared",
        "imports: { A: ../a/telo.yaml }",
        "resources: { conn: { kind: A.Thing, optional: true } }",
        "exports: { kinds: [A.Thing], resources: [A.thing] }",
      ].join("\n"),
    };
    const graph = await load(files);
    const authored = new Set<string>();
    for (const mod of graph.modules.values()) {
      for (const file of [mod.owner, ...mod.partials]) {
        for (const m of file.manifests) Object.keys(m?.metadata ?? {}).forEach((k) => authored.add(k));
      }
    }
    const stamped = new Set<string>();
    const metadataOf = [
      ...flattenForAnalyzer(graph).map((m) => m.metadata),
      ...[...(graph.scopedImportEdges?.values() ?? [])].flat().map((e) => e.member.metadata),
    ];
    for (const metadata of metadataOf) {
      for (const key of Object.keys(metadata ?? {})) if (!authored.has(key)) stamped.add(key);
    }
    expect([...stamped].filter((key) => !METADATA_STAMPS.has(key))).toEqual([]);
    expect([...stamped].sort()).toEqual(
      expect.arrayContaining([
        "exportedKinds",
        "forwardedExport",
        "hostPathInputs",
        "importPath",
        "requiredNeeds",
        "requiredResources",
        "resolvedSource",
        "scopeHolders",
        "sharedLibrary",
        "xTeloInjected",
      ]),
    );
  });
});
