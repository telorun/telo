import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments } from "../src/index.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
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

async function analyze(text: string, migrate = true) {
  const url = "/app/telo.yaml";
  const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, {
    desugarImports: true,
    migrate,
  });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  const diagnostics = new StaticAnalyzer().analyze(
    manifests,
    { moduleDocuments: collectModuleDocuments(graph) },
    registry,
  );
  return { diagnostics, registry, manifests };
}

/** A router whose route catch list marks `error` and `problem`, and a handler
 *  declaring one code with data. */
const app = (when: string, body: string, members = { code: "x-telo-caught-member: code", data: "x-telo-caught-member: data" }) => `kind: Telo.Application
metadata: { name: Shop, version: 0.1.0 }
---
kind: Telo.Definition
metadata: { name: Router }
capability: Telo.Mount
controllers:
  - pkg:telo/local/js?path=./nodejs/shop.mjs&local_path=./nodejs/src/index.ts#Router
schema:
  type: object
  properties:
    routes:
      type: array
      items:
        type: object
        properties:
          handler:
            x-telo-ref: { kind: Telo.Invocable, use: trigger.inbound }
          catches:
            type: array
            x-telo-outcome-list: catches
            x-telo-catches-for: handler
            x-telo-context:
              type: object
              additionalProperties: false
              properties:
                error:
                  type: object
                  additionalProperties: false
                  properties:
                    code: { type: string, ${members.code} }
                    data: { type: object, additionalProperties: true, ${members.data} }
                problem:
                  type: object
                  additionalProperties: false
                  properties:
                    code: { type: string, ${members.code} }
                    data: { type: object, additionalProperties: true, ${members.data} }
            items:
              type: object
              additionalProperties: false
              properties:
                when: { type: boolean }
                status: { type: integer }
                body: {}
---
kind: Telo.Definition
metadata: { name: Lookup }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/shop.mjs&local_path=./nodejs/src/index.ts#Lookup
throws:
  codes:
    ORDER_NOT_FOUND:
      description: No such order.
      data: { type: object, properties: { id: { type: string } }, required: [id] }
schema: { type: object, properties: {} }
---
kind: Shop.Lookup
metadata: { name: lookup }
---
kind: Shop.Router
metadata: { name: orders }
routes:
  - handler: !ref lookup
    catches:
      - when: !cel "${when}"
        status: 404
        body: !cel "${body}"
`;

const codes = (diagnostics: { code?: unknown }[]) => diagnostics.map((d) => d.code);

describe("caught members", () => {
  it("types every data-marked member from the codes a catch entry matches", async () => {
    const { diagnostics } = await analyze(
      app("error.code == 'ORDER_NOT_FOUND'", "[problem.data.id, problem.data.idd, error.data.idd]"),
    );
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.map((d) => (d.data as { path?: string }).path)).toEqual([
      "routes[0].catches[0].body",
      "routes[0].catches[0].body",
    ]);
    expect(unknown.map((d) => d.message).join("\n")).toMatch(/idd/);
  });

  it("proves coverage through any chain reaching a code-marked member", async () => {
    const { diagnostics } = await analyze(app("problem.code == 'ORDER_NOT_FOUND'", "problem.data.id"));
    expect(codes(diagnostics)).not.toContain("UNCOVERED_THROW_CODE");
    expect(codes(diagnostics)).not.toContain("CEL_UNKNOWN_FIELD");
  });

  it("proves nothing through a member the context does not mark, whatever its binding is named", async () => {
    // Unmigrated, so the `error` binding stays unmarked.
    const { diagnostics } = await analyze(
      app("error.code == 'ORDER_NOT_FOUND'", "error.data", { code: "description: c", data: "description: d" }),
      false,
    );
    expect(codes(diagnostics)).toContain("UNCOVERED_THROW_CODE");
    expect(codes(diagnostics)).toContain("CAUGHT_MEMBER_MISSING");
  });
});

/** An application declaring one kind with the given `schema:` body. */
const kindWith = (schema: string) => `kind: Telo.Application
metadata: { name: Kinds, version: 0.1.0 }
---
kind: Telo.Definition
metadata: { name: Thing }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/kinds.mjs&local_path=./nodejs/src/index.ts#Thing
schema:
${schema}
`;

describe("where a caught member may be marked", () => {
  const problems = async (schema: string) =>
    (await analyze(kindWith(schema))).diagnostics
      .filter((d) => typeof d.code === "string" && d.code.startsWith("CAUGHT_MEMBER_"))
      .map((d) => [d.code, (d.data as { path?: string }).path]);

  it("reports a mark in an error-bearing branch's context as misplaced", async () => {
    expect(
      await problems(`  type: object
  properties:
    catch:
      type: array
      x-telo-error-context:
        type: object
        properties:
          code: { type: string, x-telo-caught-member: code }`),
    ).toEqual([
      [
        "CAUGHT_MEMBER_MISPLACED",
        "schema.properties.catch.x-telo-error-context.properties.code.x-telo-caught-member",
      ],
    ]);
  });

  it("reports a code mark on a member that is not a string, and the list it leaves unmarked", async () => {
    expect(
      await problems(`  type: object
  properties:
    catches:
      type: array
      x-telo-outcome-list: catches
      x-telo-catches-for: ""
      x-telo-context:
        type: object
        properties:
          error:
            type: object
            properties:
              code: { type: integer, x-telo-caught-member: code }`),
    ).toEqual([
      [
        "CAUGHT_MEMBER_MISPLACED",
        "schema.properties.catches.x-telo-context.properties.error.properties.code.x-telo-caught-member",
      ],
      ["CAUGHT_MEMBER_MISSING", "schema.properties.catches"],
    ]);
  });
});
