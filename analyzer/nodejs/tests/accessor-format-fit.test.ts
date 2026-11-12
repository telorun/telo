import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/** An accessor chain's declared source against the formats its field takes. */

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

const KINDS = `kind: Telo.Library
metadata: { name: Fmt, version: 0.1.0 }
---
kind: Telo.Definition
metadata: { name: Show }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    content:
      type: object
      x-telo-context:
        type: object
        additionalProperties: false
        properties:
          data:
            type: object
            additionalProperties: false
            properties:
              title: { type: string }
              email: { type: string, format: email }
              day: { type: string, format: date }
              stamp: { type: string, format: date-time }
              maybeStamp: { anyOf: [{ type: string, format: date-time }, { type: "null" }] }
              maybeTitle: { anyOf: [{ type: string }, { type: "null" }] }
              count: { type: integer }
              loose: {}
              bag: { type: object }
      properties:
        at: { type: string, format: date-time, x-telo-eval: accessor }
        when:
          x-telo-eval: accessor
          anyOf: [{ type: string, format: date }, { type: string, format: date-time }]
        label: { type: string, x-telo-eval: accessor }
        since: { type: [string, "null"], format: date-time, x-telo-eval: accessor }
`;

async function analyze(body: string) {
  const url = "/lib/telo.yaml";
  const graph = await new Loader([source({ [url]: KINDS + body })]).loadGraph(url, { desugarImports: true });
  return new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {}, new AnalysisRegistry());
}

const typeErrors = (diagnostics: Array<{ code?: unknown; message: string; data?: unknown }>) =>
  diagnostics
    .filter((d) => d.code === "CEL_TYPE_ERROR")
    .map((d) => `${(d.data as { path?: string } | undefined)?.path}: ${d.message}`);

const show = (content: string) => `---
kind: Self.Show
metadata: { name: page }
content:
${content}
`;

describe("format-aware accessor slot fit", () => {
  it("refuses a string with no format where the field takes one", async () => {
    expect(typeErrors(await analyze(show(`  at: !cel "data.title"`)))).toEqual([
      "content.at: Self.Show/page: CEL at 'content.at': 'data.title' is a string with no format; the field takes a string of format date-time.",
    ]);
  });

  it("refuses a string of a format the field does not take", async () => {
    expect(typeErrors(await analyze(show(`  at: !cel "data.email"`)))).toEqual([
      "content.at: Self.Show/page: CEL at 'content.at': 'data.email' is a string of format email; the field takes a string of format date-time.",
    ]);
  });

  it("admits a matching format, ignoring a null branch of the source", async () => {
    expect(typeErrors(await analyze(show(`  since: !cel "data.maybeStamp"`)))).toEqual([]);
    expect(typeErrors(await analyze(show(`  since: !cel "data.maybeTitle"`)))).toEqual([
      "content.since: Self.Show/page: CEL at 'content.since': 'data.maybeTitle' is a string with no format; the field takes a string of format date-time.",
    ]);
  });

  it("takes every format of a union slot whose branches each declare one", async () => {
    expect(typeErrors(await analyze(show(`  when: !cel "data.day"`)))).toEqual([]);
    expect(typeErrors(await analyze(show(`  when: !cel "data.stamp"`)))).toEqual([]);
    expect(typeErrors(await analyze(show(`  when: !cel "data.email"`)))).toEqual([
      "content.when: Self.Show/page: CEL at 'content.when': 'data.email' is a string of format email; the field takes a string of format date or date-time.",
    ]);
  });

  it("is silent for an unconstrained field and an open, dyn or non-string source", async () => {
    const diagnostics = await analyze(show(`  label: !cel "data.email"`));
    expect(typeErrors(diagnostics)).toEqual([]);
    for (const chain of ["data.loose", "data.bag.anything"]) {
      expect(typeErrors(await analyze(show(`  at: !cel "${chain}"`)))).toEqual([]);
    }
    const numeric = typeErrors(await analyze(show(`  at: !cel "data.count"`)));
    expect(numeric).toHaveLength(1);
    expect(numeric[0]).not.toContain("format");
  });

  it("judges template-body entries, scope members and forward views", async () => {
    const diagnostics = await analyze(`---
kind: Telo.Definition
metadata: { name: Box }
capability: Telo.Invocable
schema:
  type: object
  properties:
    at: { type: string, format: date-time }
resources:
  - kind: Self.Show
    metadata: { name: shown }
    content:
      at: !cel "self.at"
      label: !cel "data.title"
      when: !cel "data.title"
invoke: !ref shown
---
kind: Self.Box
metadata: { name: boxed }
at: !cel "data.title"
---
kind: Telo.Sequence
metadata: { name: seq }
with:
  - kind: Self.Show
    metadata: { name: member }
    content:
      at: !cel "data.title"
steps: []
`);
    expect(typeErrors(diagnostics)).toEqual([
      "resources[0].content.when: Telo.Definition/Box: CEL at 'resources[0].content.when': 'data.title' is a string with no format; the field takes a string of format date or date-time.",
      "with[0].content.at: Self.Show/member: CEL at 'content.at': 'data.title' is a string with no format; the field takes a string of format date-time.",
      "at: Self.Box/boxed: 'at' is forwarded into the Self.Show entry 'shown' as 'content.at', which checks it as its own field — CEL at 'at': 'data.title' is a string with no format; the field takes a string of format date-time.",
    ]);
  });
});
