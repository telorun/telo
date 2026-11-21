import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/** `x-telo-eval: accessor-template` — a structure of accessors, each leaf
 *  judged as an accessor at its own path. */

function source(files: Record<string, string>): ManifestSource {
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

const LIBRARY = `kind: Telo.Library
metadata: { name: Acme, version: 0.1.0 }
lang: en
`;

const REQUEST = `---
kind: Telo.Definition
metadata: { name: Request }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  additionalProperties: false
  required: [model, body]
  properties:
    model:
      x-telo-ref: { kind: Telo.Type, use: schema }
    body:
      type: object
      x-telo-eval: accessor-template
      x-telo-value-schema-from: model
      x-telo-context:
        type: object
        properties:
          query:
            x-telo-context-eval: accessor
            type: object
            properties:
              from: { type: string, format: date }
              text: { type: string }
              size: { type: [integer, "null"] }
          page: { x-telo-context-eval: runtime, type: object }
---
kind: Telo.JsonSchema
metadata: { name: ReportRequest }
schema:
  type: object
  additionalProperties: false
  required: [period, size]
  properties:
    period:
      type: object
      additionalProperties: false
      required: [from]
      properties: { from: { type: string, format: date } }
    size: { type: integer }
`;

async function analyze(text: string) {
  const url = "/lib/telo.yaml";
  const graph = await new Loader([source({ [url]: text })]).loadGraph(url, { desugarImports: true });
  return new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {}, new AnalysisRegistry());
}

const findings = (diagnostics: Array<{ code?: unknown; message: string; data?: unknown }>) =>
  diagnostics
    .filter((d) => d.severity === undefined || (d as { severity?: number }).severity === 1)
    .map((d) => `${d.code} ${(d.data as { path?: string } | undefined)?.path}: ${d.message}`);

const request = (body: string) => `${LIBRARY}${REQUEST}---
kind: Self.Request
metadata: { name: report }
model: !ref ReportRequest
body:
${body}
`;

describe("an accessor template judged against the type it names", () => {
  it("admits chains of the member's type and format, one that may hold nothing included", async () => {
    const diagnostics = await analyze(request(`  period: { from: !cel "query.from" }\n  size: !cel "query.size"`));
    expect(findings(diagnostics)).toEqual([]);
  });

  it("refuses a missing member, a chain of another type and a chain of another format", async () => {
    const diagnostics = await analyze(request(`  size: !cel "query.text"`));
    expect(findings(diagnostics)).toEqual([
      "SCHEMA_VIOLATION body.period: Self.Request/report: `body` does not satisfy the type declared at `model`: / is missing required property 'period'",
      "CEL_TYPE_ERROR body.size: Self.Request/report: CEL at 'body.size' reads 'query.text', whose declared shape does not fit what the field expects: /: type mismatch — source is 'string', target expects 'integer'.",
    ]);
    const formats = await analyze(request(`  period: { from: !cel "query.text" }\n  size: 20`));
    expect(findings(formats)).toEqual([
      "CEL_TYPE_ERROR body.period.from: Self.Request/report: CEL at 'body.period.from': 'query.text' is a string with no format; the field takes a string of format date.",
    ]);
  });

  it("refuses a leaf rooted at a binding that exists at no accessor", async () => {
    const diagnostics = await analyze(request(`  period: { from: !cel "page.from" }\n  size: 20`));
    expect(findings(diagnostics)).toContain(
      "CEL_UNKNOWN_IDENTIFIER body.period.from: Self.Request/report: !cel: unknown identifier 'page' — nothing by that name is in scope here.",
    );
  });
});

describe("an annotation naming an accessor template", () => {
  it("is refused for x-telo-match-for", async () => {
    const diagnostics = await analyze(`${LIBRARY}---
kind: Telo.Definition
metadata: { name: Filter }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    criteria:
      type: object
      x-telo-eval: accessor-template
      x-telo-context: { type: object, properties: { row: { type: object } } }
    matches: { type: object, x-telo-match-for: /criteria }
`);
    expect(findings(diagnostics)).toEqual([
      expect.stringMatching(/^MATCH_FOR_INVALID .*is an 'x-telo-eval: accessor-template' field/),
    ]);
  });

  it("is refused for x-telo-text-values-for", async () => {
    const diagnostics = await analyze(`${LIBRARY}---
kind: Telo.Definition
metadata: { name: Label }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    text: { $ref: "telo://manifest#/$defs/Text" }
    values:
      type: object
      x-telo-eval: accessor-template
      x-telo-text-values-for: /text
      x-telo-context: { type: object, properties: { row: { type: object } } }
`);
    expect(findings(diagnostics)).toEqual([
      expect.stringMatching(/^TEXT_VALUES_INVALID .*the values 'values' are an 'x-telo-eval: accessor-template' field/),
    ]);
  });
});
